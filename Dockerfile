FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate

# Baked into the bundle at build time as the FALLBACK for public/runtime-config.js. Both pieces are
# required: a --build-arg with no matching ARG here is silently dropped and the bundle ships blank.
# Note `docker run -e NEXT_PUBLIC_HOTJAR_SITE_ID=...` does nothing -- Next reads NEXT_PUBLIC_* from
# the `next build` process, so the value has to arrive here, or at runtime via runtime-config.js.
ARG NEXT_PUBLIC_HOTJAR_SITE_ID
ENV NEXT_PUBLIC_HOTJAR_SITE_ID=${NEXT_PUBLIC_HOTJAR_SITE_ID}
RUN npm run build
EXPOSE 3000
CMD ["npm", "start"]
