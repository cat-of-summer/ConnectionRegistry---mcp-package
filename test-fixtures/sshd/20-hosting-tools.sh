#!/bin/bash
# Что на мишени должно быть «как на хостинге»:
#   - PHP CLI — для secret_import с format: php: реквизиты базы реестр читает из конфига
#     приложения самим php на сервере;
#   - консольные mysql и psql — для подключений db с via: exec, где запросы выполняет
#     клиент на сервере, потому что SSH-проброс закрыт.
# Имена пакетов зависят от версии Alpine в образе, поэтому берётся первый доступный.
for pkg in php84 php83 php82; do
  apk add --no-cache "$pkg" >/dev/null 2>&1 && break
done
command -v php >/dev/null 2>&1 || ln -s "$(ls /usr/bin/php8* | head -n 1)" /usr/bin/php

apk add --no-cache mariadb-client mariadb-connector-c >/dev/null 2>&1 || true
for pkg in postgresql17-client postgresql16-client postgresql-client; do
  apk add --no-cache "$pkg" >/dev/null 2>&1 && break
done
