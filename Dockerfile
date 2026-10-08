# ============================================================
# Dockerfile — 植伴 v5 线上部署镜像（零依赖 Node，可部署到任意容器平台）
# 构建：docker build -t zhiban:v5 .
# 运行：docker run -p 8080:8080 --env-file server/.env zhiban:v5
#   （凭证永远走环境变量注入，不进镜像与仓库）
# 回滚：保留带版本 tag 的旧镜像；CloudBase/容器平台支持"回滚到上一版本"
# ============================================================
FROM node:20-alpine

WORKDIR /app
# 只拷贝运行所需最小面：前端外壳 + 服务端目录 + 入口（白名单件）
# 不含：test/test-results/screenshots/REVIEW 文档/package-lock/.env/node_modules
COPY server/ ./server/
COPY js/ ./js/
COPY css/ ./css/
COPY icons/ ./icons/
COPY index.html manifest.webmanifest ./
COPY package.json ./

ENV PORT=8080 NODE_ENV=production
EXPOSE 8080
CMD ["node", "server/server.js"]