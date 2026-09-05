FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
WORKDIR /site
COPY index.html styles.css app.js robots.txt sitemap.xml llms.txt api.md ./
EXPOSE 8080
