FROM python:3.12-slim

ARG APP_VERSION=dev

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    DASHBOARD_APP_VERSION=$APP_VERSION

WORKDIR /app

RUN groupadd --system dashboard && useradd --system --gid dashboard --home-dir /app dashboard

COPY backend/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

COPY backend/app /app/app
COPY frontend /app/frontend
RUN mkdir -p /app/data && chown -R dashboard:dashboard /app

USER dashboard
EXPOSE 8787

CMD ["python", "-m", "app.serve"]
