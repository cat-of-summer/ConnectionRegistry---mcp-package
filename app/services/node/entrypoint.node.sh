#!/bin/sh
set -e

WORKDIR="/var/www/html/${NODE_WORKDIR:-.}"
TIMEOUT="${NODE_WAIT_TIMEOUT:-300}"
MODE="${NODE_MODE:-build}"

mkdir -p "$WORKDIR"
cd "$WORKDIR"

waited=0
while [ ! -f "package.json" ] && [ "$waited" -lt "$TIMEOUT" ]; do
  [ "$waited" = 0 ] && echo "[node] Жду $WORKDIR/package.json (до ${TIMEOUT}с)..."
  sleep 2
  waited=$((waited + 2))
done

if [ ! -f "package.json" ]; then
  echo "[node] Нет package.json в $WORKDIR спустя ${TIMEOUT}с. Простаиваю."
  exec sleep infinity
fi

install_deps() {
  if [ -f "yarn.lock" ]; then
    command -v yarn >/dev/null 2>&1 || npm install -g yarn || echo "[node] yarn bootstrap failed (continuing)"
    yarn install --frozen-lockfile || yarn install || echo "[node] yarn install failed (continuing)"
    return
  fi

  if [ ! -f "package-lock.json" ]; then
    npm install || echo "[node] npm install failed (continuing)"
    return
  fi

  if [ -f "node_modules/.package-lock.json" ] && [ ! "package-lock.json" -nt "node_modules/.package-lock.json" ]; then
    echo "[node] Зависимости актуальны, установка пропущена."
    return
  fi

  npm ci || {
    echo "[node] npm ci не прошёл — откатываюсь на npm install"
    npm install || echo "[node] npm install failed (continuing)"
  }
}

install_deps

# Свои bin-скрипты проекта — в PATH, чтобы `docker compose exec` вызывал их по имени.
# Кладём обёртку в файловую систему контейнера, а не симлинк на смонтированный файл:
# правка исходника из Windows или IDE сбрасывает бит исполнения, и симлинк умирает.
node -e '
  const fs = require("fs"), path = require("path");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const bin = typeof pkg.bin === "string" ? { [pkg.name]: pkg.bin } : (pkg.bin || {});
  for (const [name, file] of Object.entries(bin)) {
    const abs = path.resolve(file);
    if (!fs.existsSync(abs)) continue;
    const wrapper = "/usr/local/bin/" + name;
    try {
      fs.rmSync(wrapper, { force: true });
      fs.writeFileSync(wrapper, "#!/bin/sh\nexec node " + JSON.stringify(abs) + " \"$@\"\n");
      fs.chmodSync(wrapper, 0o755);
      console.log("[node] команда " + name + " готова");
    } catch (e) {
      console.log("[node] не удалось создать команду " + name + ": " + e.message);
    }
  }
' 2>/dev/null || true

case "$MODE" in
  mcp)
    echo "[node] MCP-сервер на 0.0.0.0:${MCP_PORT:-8932}"
    exec npm run mcp:http
    ;;
  test)
    exec npm test
    ;;
  idle)
    echo "[node] Режим idle. Простаиваю."
    exec sleep infinity
    ;;
  dev)
    echo "[node] Vite dev server на 0.0.0.0:${VITE_PORT:-5173}"
    exec npm run dev -- --host 0.0.0.0 --port "${VITE_PORT:-5173}"
    ;;
  nuxt)
    npm run build || { echo "[node] nuxt build упал"; exec sleep infinity; }
    echo "[node] Nuxt SSR на 0.0.0.0:${NODE_PORT:-3000}"
    exec node .output/server/index.mjs
    ;;
  generate)
    npm run generate || echo "[node] generate упал (continuing)"
    echo "[node] Статика собрана. Простаиваю."
    exec sleep infinity
    ;;
  serve)
    exec npm start
    ;;
  *)
    rm -f "/var/www/html/${PHP_WORKDIR:-.}/public/hot"
    npm run build --if-present || echo "[node] npm run build failed (continuing)"
    echo "[node] Ассеты собраны. Простаиваю."
    exec sleep infinity
    ;;
esac
