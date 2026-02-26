# Node.js 20 + ffmpeg이 포함된 베이스 이미지
FROM node:20-slim

# ffmpeg 설치
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    python3 \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# 작업 디렉토리 설정
WORKDIR /app

# package.json 먼저 복사 후 의존성 설치
COPY package*.json ./
RUN npm ci --only=production

# 나머지 파일 복사
COPY . .

# 포트 오픈 (Koyeb 헬스체크용)
EXPOSE 8000

CMD ["node", "index.js"]