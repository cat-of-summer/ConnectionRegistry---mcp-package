import { cfg } from '../config.js';
import { projects as knownProjects } from '../registry/connections.js';

// Политика отвечает на один вопрос: какие разрешения нужны этому вызову и в каком порядке
// их спрашивать. Гейт её решения только исполняет — так вся «кому и что можно» лежит в
// одном файле, который читается сверху вниз, а не размазана по ветвлениям.
//
// Ступень: { scope, key, summary, details }.
//   scope 'call'  — ключа нет, спрашивается каждый раз;
//   остальные     — ключ разрешения, выданного на сессию: project:<имя>, host:<алиас>, session.
// auto: true — ступень выдаётся без вопроса и всё равно запоминается: человек увидит её
// в registry_info и в журнале.

export const REMOTE_GROUPS = ['shell', 'files', 'docker', 'db'];
const isRemote = (group) => REMOTE_GROUPS.includes(group);

// Обзорные инструменты не спрашивают ничего даже при фильтре по проекту: без них агент
// не увидел бы, какие проекты есть, и не понял бы, к какому просить доступ. Журнал —
// запись самого человека, и смотреть её он агенту не запрещал.
const SURVEY_GROUPS = ['service', 'audit'];
const SURVEY_TOOLS = ['conn_list', 'host_list', 'notes_search'];
export const isSurvey = (call) => SURVEY_GROUPS.includes(call.group) || SURVEY_TOOLS.includes(call.tool);

/** Проекты, которых касается вызов: свой плюс объявленные инструментом. */
function touched(call) {
  return [...new Set([call.project, ...(call.projects || [])])].filter(Boolean);
}

export const POLICIES = {
  /**
   * Базовая: разрешение на запись выдаётся сессии, потом каждому проекту. Доступы к
   * серверам — хосты, подключения, секреты — спрашиваются каждый раз, потому что меняют
   * не работу внутри проекта, а то, куда реестр вообще может ходить.
   */
  base: {
    name: 'base',
    title: 'базовая',

    ladder(call) {
      if (call.everyTime) {
        return [{ scope: 'call', summary: call.summary, details: call.details }];
      }
      if (!call.mutating) return [];

      const steps = [{
        scope: 'session',
        key: 'session',
        summary: 'Разрешить этой сессии агента менять что-либо на серверах и в базах?',
        details: {
          'первое действие': call.summary,
          'что это значит': 'Спрашиваю один раз за сессию. Дальше на каждый новый проект будет ещё один вопрос, '
            + 'а внутри разрешённого проекта вопросов не будет. Отказ запретит запись до конца сессии.',
        },
      }];

      if (call.project) {
        steps.push({
          scope: 'project',
          key: `project:${call.project}`,
          project: call.project,
          summary: `Разрешить запись в проект «${call.project}» до конца сессии?`,
          details: {
            'первое действие': call.summary,
            'что это значит': 'Да — дальше в этом проекте вопросов не будет. Нет — проект останется только '
              + 'на чтение до конца сессии, и спрашивать о нём я больше не буду.',
          },
        });
      }

      return steps;
    },

    refusal(step) {
      if (step.scope === 'session') {
        return 'запись в этой сессии запрещена человеком — он отказал на первом же изменяющем вызове';
      }
      if (step.scope === 'project') {
        return `проект «${step.project}» человек оставил только на чтение до конца сессии`;
      }
      return 'человек отказал';
    },

    wording: {
      session: { granted: 'запись разрешена', denied: 'запись запрещена' },
      project: { granted: 'запись разрешена', denied: 'только чтение' },
    },

    help: {
      ru: [
        'Чтение не спрашивается никогда: conn_list, files_list/read/get, docker_ps/logs, SELECT, журнал.',
        '',
        'Запись спрашивается дважды за сессию и больше не спрашивается:',
        '  1. первый изменяющий вызов — «разрешить этой сессии менять что-либо»;',
        '  2. первая запись в каждый проект — «разрешить запись в проект X».',
        'Дальше внутри разрешённого проекта вопросов нет. Отказ на втором вопросе оставляет проект',
        'только на чтение до конца сессии: повторно о нём не спрашивают, сразу отвечают отказом.',
        '',
        'Каждый раз спрашиваются только доступы: host_set, host_remove, secret_set, conn_set, conn_remove.',
        'Это не работа внутри проекта, а изменение того, куда и чем реестр может ходить.',
      ],
      en: [
        'Reads are never confirmed: conn_list, files_list/read/get, docker_ps/logs, SELECT, the journal.',
        '',
        'Writes are confirmed twice per session and never again:',
        '  1. the first mutating call — "let this session change anything";',
        '  2. the first write into each project — "allow writing to project X".',
        'Inside a granted project there are no further questions. Refusing the second question leaves',
        'that project read-only until the session ends; it is never asked about again.',
        '',
        'Access changes are confirmed every time: host_set, host_remove, secret_set, conn_set, conn_remove.',
        'That is not work inside a project but a change to where the registry may go at all.',
      ],
    },

    short: {
      ru: [
        'Чтение не спрашивает ничего. На запись человек даёт разрешение один раз за сессию и один раз',
        'на проект, дальше внутри проекта вопросов нет; правка хостов, секретов и подключений',
        'спрашивается каждый раз.',
      ],
      en: [
        'Reads ask nothing. Writes need the human to grant them once per session and once per project;',
        'after that there are no questions inside that project, while host, secret and connection edits',
        'are confirmed every time.',
      ],
    },
  },

  /**
   * Лояльная: разрешение выдаётся на область работы, а не на действие. Сначала доступ к
   * проекту — он открывает и чтение, и всю работу с реестром внутри проекта. Отдельно и
   * позже спрашивается право писать на хост: оно покрывает все подключения этого сервера.
   */
  loyal: {
    name: 'loyal',
    title: 'лояльная',

    ladder(call) {
      if (isSurvey(call)) return [];

      const steps = [];
      const existing = touched(call).length ? new Set(knownProjects()) : null;

      for (const project of touched(call)) {
        // Проект, которого ещё нет, агент заводит сам — и получает к нему доступ вместе с
        // заведением: спрашивать «пустить ли тебя туда, куда ты только что кладёшь» нечего.
        if (!existing.has(project)) {
          steps.push({ scope: 'project', key: `project:${project}`, project, auto: true });
          continue;
        }

        steps.push({
          scope: 'project',
          key: `project:${project}`,
          project,
          summary: `Дать агенту доступ к проекту «${project}» до конца сессии?`,
          details: {
            'первое действие': call.summary,
            'что это значит': 'Доступ открывает чтение через подключения проекта и работу с его заметками, '
              + 'подключениями и секретами. Читать сами пароли и ключи он не даёт: их не возвращает ни один '
              + 'инструмент. На запись по серверу будет отдельный вопрос. Отказ закроет проект до конца сессии.',
          },
        });
      }

      if (call.mutating && isRemote(call.group) && call.host) {
        steps.push({
          scope: 'host',
          key: `host:${call.host}`,
          host: call.host,
          summary: `Разрешить запись на хост «${call.host}» до конца сессии?`,
          details: {
            'первое действие': call.summary,
            'что это значит': 'Разрешение покрывает все подключения этого сервера сразу — shell, файлы, '
              + 'docker, базу. Другие хосты спросят отдельно. Отказ оставит сервер только на чтение '
              + 'до конца сессии.',
          },
        });
      }

      return steps;
    },

    refusal(step) {
      if (step.scope === 'project') {
        return `проект «${step.project}» закрыт человеком до конца сессии`;
      }
      if (step.scope === 'host') {
        return `хост «${step.host}» человек оставил только на чтение до конца сессии`;
      }
      return 'человек отказал';
    },

    wording: {
      project: { granted: 'доступ есть', denied: 'закрыт' },
      host: { granted: 'запись разрешена', denied: 'только чтение' },
    },

    help: {
      ru: [
        'Разрешение выдаётся на область работы, а не на действие, и спрашивается двумя ступенями.',
        '',
        '  1. Доступ к проекту — на первом же обращении к нему, хоть на чтение. Он открывает чтение',
        '     через подключения проекта и всю работу с реестром внутри: заметки, подключения, секреты.',
        '     Проект, которого ещё не было, агент заводит сам и получает доступ без вопроса.',
        '  2. Запись на хост — на первом изменяющем вызове через его подключения. Одно разрешение',
        '     покрывает весь сервер: shell, файлы, docker, базу. Другой хост спросит отдельно.',
        '',
        'Ничего не спрашивают обзорные инструменты: help, registry_info, conn_list, host_list,',
        'notes_search, журнал. Без них агент не понял бы, к какому проекту просить доступ.',
        '',
        'Отказ по проекту закрывает проект целиком до конца сессии, отказ по хосту — только запись',
        'на него; повторно о том же не спрашивают, сразу отвечают отказом.',
        '',
        'Секреты по-прежнему не читает никто: ни один инструмент не возвращает пароль или ключ.',
      ],
      en: [
        'A grant covers an area of work, not a single action, and is asked in two steps.',
        '',
        '  1. Access to a project — on the very first call that touches it, even a read. It opens reading',
        '     through the project connections and all registry work inside it: notes, connections, secrets.',
        '     A project that did not exist yet is created by the agent and granted without a question.',
        '  2. Write access to a host — on the first mutating call through its connections. One grant covers',
        '     the whole server: shell, files, docker, database. Another host is asked separately.',
        '',
        'Survey tools ask nothing: help, registry_info, conn_list, host_list, notes_search, the journal.',
        'Without them the agent could not tell which project to ask access for.',
        '',
        'Refusing a project closes it entirely until the session ends; refusing a host only blocks writing',
        'to it. Neither is asked twice — the answer is remembered.',
        '',
        'Secrets are still read by no one: no tool returns a password or a key.',
      ],
    },

    short: {
      ru: [
        'Разрешения идут двумя ступенями: доступ к проекту — на первом обращении к нему, даже на чтение;',
        'право записи на хост — на первом изменяющем вызове, и покрывает все подключения этого сервера.',
        'Заметки, подключения и секреты проекта входят в доступ к проекту. Новый проект агент заводит',
        'сам и получает доступ без вопроса. Секретов не возвращает ни один инструмент.',
      ],
      en: [
        'Grants come in two steps: access to a project on the first call that touches it, even a read;',
        'write access to a host on the first mutating call, covering every connection of that server.',
        'Notes, connections and secrets of a project fall under the project access. A new project is',
        'created by the agent and granted without a question. No tool ever returns a secret.',
      ],
    },
  },
};

function choose() {
  const name = String(cfg.policy || 'base').trim().toLowerCase();
  const found = POLICIES[name];
  if (!found) {
    throw new Error(
      `CR_POLICY=«${cfg.policy}» — такой политики подтверждений нет. Есть: ${Object.keys(POLICIES).join(', ')}. `
      + 'Тихо откатиться на базовую нельзя: человек думал бы, что включил одну, а работает другая.',
    );
  }
  return found;
}

export const policy = choose();
