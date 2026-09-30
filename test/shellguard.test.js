import test from 'node:test';
import assert from 'node:assert/strict';
import { writeSigns, scriptSigns } from '../src/shellguard.js';

// Эвристика стоит перед каждым ssh_exec на хосте «только для чтения». Ошибка в одну сторону —
// тихая запись на проде, в другую — вопрос на каждое ls, после которого вопросы перестают читать.

const READS = [
  'ls -la /var/www',
  'cat application/config/production/database.php',
  'grep -rn "smtp" application/config 2>/dev/null',
  'tail -n 200 /var/log/nginx/error.log 2>&1 | head',
  'php -v && php -m',
  'git status && git log --oneline -5 && git diff',
  'crontab -l',
  'systemctl status nginx',
  'docker ps -a && docker logs app --tail 50',
  'mysql -e "SELECT id FROM users LIMIT 5"',
  "mysql shop -e 'show tables'",
  'psql -c "select 1"',
  'mysqldump --no-data shop',
  'find . -name "*.php" -mtime -1',
  'echo "a > b" && echo \'rm -rf /\'',
  'awk \'$3 > 100 {print}\' access.log',
  'du -sh * >/dev/null',
  'php artisan route:list',
  'cat <<EOF\nrm -rf /\nEOF',
  'test -f x && echo yes',
];

const WRITES = [
  ['rm -f /tmp/x.php', /rm/],
  ['echo 1 > /tmp/flag', /запись в файл \/tmp\/flag/],
  ['echo a>f', /запись в файл f/],
  ['date >> log.txt', /запись в файл log\.txt/],
  ['ls | tee out.txt', /tee/],
  ['mv a b', /mv/],
  ['sed -i "s/a/b/" config.php', /sed -i/],
  ['perl -pi -e "s/a/b/" f', /perl -i/],
  ['git pull origin master', /git pull/],
  ['git -C /srv/app checkout dev', /git checkout/],
  ['crontab /tmp/cron', /crontab/],
  ['crontab -e', /crontab/],
  ['sudo systemctl restart nginx', /systemctl restart/],
  ['service php7.4-fpm reload', /service/],
  ['docker compose up -d', /docker compose up/],
  ['docker restart app', /docker restart/],
  ['mysql -e "UPDATE users SET a = 1"', /mysql: update/],
  ['mysql shop < dump.sql', /mysql без -e/],
  ['psql -c "drop table x"', /psql: drop/],
  ['php artisan migrate --force', /artisan migrate/],
  ['cd /srv && php artisan cache:clear', /artisan cache:clear/],
  ['composer install --no-dev', /composer install/],
  ['find /tmp -name "*.tmp" -delete', /find -delete/],
  ['find . -name x -exec rm {} \\;', /rm/],
  ['sh -c "rm -rf cache"', /rm/],
  ['echo $(touch /tmp/x)', /touch/],
  ['FOO=1 nohup rm x &', /rm/],
  ['cat <<EOF > /tmp/x.php\n<?php echo 1;\nEOF', /запись в файл \/tmp\/x\.php/],
];

test('читающие команды приметы не дают', () => {
  for (const command of READS) {
    assert.deepEqual(writeSigns(command), [], command);
  }
});

test('изменяющие команды узнаются и называются', () => {
  for (const [command, expected] of WRITES) {
    const signs = writeSigns(command);
    assert.ok(signs.some((s) => expected.test(s)), `${command} → ${JSON.stringify(signs)}`);
  }
});

test('скрипт не на шелле — сам по себе примета', () => {
  assert.deepEqual(scriptSigns('ls\nls -la', 'bash'), []);
  assert.match(scriptSigns('print(1)', 'python3')[0], /python3/);
  assert.ok(scriptSigns('rm x', '/bin/sh').includes('rm'));
});
