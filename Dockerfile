# 单镜像同时承载 web（nginx 静态站点 + /health）与 verify（Node 验收）
FROM node:20-alpine

RUN apk add --no-cache nginx \
    && mkdir -p /run/nginx /usr/share/nginx/html

COPY nginx.conf /etc/nginx/http.d/default.conf
COPY src/ /usr/share/nginx/html/
COPY src/ /app/src/
COPY tests/ /app/tests/
COPY verify/ /app/verify/

WORKDIR /app
EXPOSE 80

# 默认作为 web 服务启动；verify 服务在 Compose 中覆盖 command
CMD ["nginx", "-g", "daemon off;"]
