FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server.mjs ./
COPY src ./src
COPY public ./public
COPY data ./data
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
