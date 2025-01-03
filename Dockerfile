FROM node:23-alpine3.20

WORKDIR /server

COPY ./ /server

EXPOSE 1234

ENTRYPOINT ["npx", "tsx", "/server/httpServer.ts"]
