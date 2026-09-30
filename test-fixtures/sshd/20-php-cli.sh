#!/bin/bash
# PHP CLI на мишени — для db_credentials_import с format: php: реквизиты базы реестр читает
# из конфига приложения самим php на хосте. Имя пакета зависит от версии Alpine в образе,
# поэтому берётся первый доступный, а `php` без номера ставится ссылкой.
for pkg in php84 php83 php82; do
  apk add --no-cache "$pkg" >/dev/null 2>&1 && break
done
command -v php >/dev/null 2>&1 || ln -s "$(ls /usr/bin/php8* | head -n 1)" /usr/bin/php
