FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY watchdog/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt \
    && useradd --create-home --home-dir /app --shell /usr/sbin/nologin --uid 10001 vertex

COPY watchdog /app/watchdog
RUN mkdir -p /app/data/nautilus/logs \
    && chown -R vertex:vertex /app

USER vertex

EXPOSE 8081

CMD ["python", "-m", "watchdog.watchdog"]
