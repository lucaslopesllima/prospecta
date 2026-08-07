# Imagem de produção do AutoPost (FastAPI + APScheduler in-process).
#
# UM worker só: o agendador vive dentro do processo (app/main.py). Subir mais
# workers duplicaria cada publicação agendada.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /srv

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY manage.py .

# SQLite, uploads e log ficam no volume montado aqui (ver docker-compose.prod.yml).
ENV DB_PATH=/srv/data/app.db \
    UPLOAD_DIR=/srv/data/uploads \
    LOG_FILE=/srv/data/app.log

EXPOSE 8000

# Sem curl/wget na slim — urllib basta.
HEALTHCHECK --interval=15s --timeout=5s --retries=5 --start-period=20s \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8000/health', timeout=4).status == 200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
