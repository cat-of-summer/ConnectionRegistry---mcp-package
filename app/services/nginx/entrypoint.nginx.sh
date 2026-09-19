#!/bin/sh
set -e

CONF="${NGINX_CONF:-php}"
TPL="/etc/nginx/configs/nginx.${CONF}.conf"

if [ ! -f "$TPL" ]; then
  echo "[nginx] Нет шаблона $TPL. Доступные NGINX_CONF:"
  ls /etc/nginx/configs/ | sed 's/^nginx\.//; s/\.conf$//; s/^/  /'
  exit 1
fi

DOCKER_NETWORK="$(ip route | grep -v default | awk '{print $1}' | head -1)"
[ -n "$DOCKER_NETWORK" ] || DOCKER_NETWORK="172.16.0.0/12"

if [ "${TRAEFIK_ENTRYPOINT}" = "websecure" ]; then FASTCGI_HTTPS=on; else FASTCGI_HTTPS=off; fi

if [ -n "${HTTP_LOGIN}" ] && [ -n "${HTTP_PASSWORD}" ]; then
  printf '%s:%s\n' "${HTTP_LOGIN}" "$(openssl passwd -apr1 "${HTTP_PASSWORD}")" > /etc/nginx/.htpasswd
  AUTH_BASIC="Restricted"
else
  : > /etc/nginx/.htpasswd
  AUTH_BASIC="off"
fi

if [ -n "${DIST_PATH}" ]; then NODE_FALLBACK="/index.html"; else NODE_FALLBACK="@node"; fi

# Промах по файлу отдаём в код: без этого нельзя сгенерировать robots.txt или картинку
# на лету — nginx отвечает 404 раньше, чем запрос доходит до приложения. Включено там,
# где раскладка гарантирует фронт-контроллер; у bitrix и wordpress своя маршрутизация.
case "$CONF" in
  api|laravel|apache) FALLBACK_DEFAULT=true ;;
  *)                  FALLBACK_DEFAULT=false ;;
esac

if [ "${PHP_FALLBACK:-$FALLBACK_DEFAULT}" = "true" ]; then
  if [ "$CONF" = "apache" ]; then
    ERROR_PAGE_404="error_page 404 = @apache;"
  else
    ERROR_PAGE_404="error_page 404 = /index.php;"
  fi
else
  ERROR_PAGE_404=""
fi

INSTANCE="${INSTANCE:-}"
PHP_WORKDIR="${PHP_WORKDIR:-.}"
DIST_PATH="${DIST_PATH:-}"
NODE_PORT="${NODE_PORT:-3000}"
PYTHON_PORT="${PYTHON_PORT:-8000}"
APACHE_PORT="${APACHE_PORT:-80}"
MCP_PORT="${MCP_PORT:-8931}"
CLIENT_MAX_BODY_SIZE="${CLIENT_MAX_BODY_SIZE:-64M}"

export DOCKER_NETWORK FASTCGI_HTTPS AUTH_BASIC NODE_FALLBACK ERROR_PAGE_404 INSTANCE \
       PHP_WORKDIR DIST_PATH NODE_PORT PYTHON_PORT APACHE_PORT MCP_PORT CLIENT_MAX_BODY_SIZE

defined=$(printenv | cut -d= -f1 | sed 's/^/${/; s/$/}/' | tr '\n' ' ')

mkdir -p /etc/nginx/snippets
for s in /etc/nginx/configs/snippets/*.conf; do
  [ -f "$s" ] || continue
  envsubst "$defined" < "$s" > "/etc/nginx/snippets/$(basename "$s")"
done

envsubst "$defined" < "$TPL" > /etc/nginx/conf.d/default.conf

echo "[nginx] NGINX_CONF=${CONF} PHP_FALLBACK=${PHP_FALLBACK:-$FALLBACK_DEFAULT}"

exec "$@"
