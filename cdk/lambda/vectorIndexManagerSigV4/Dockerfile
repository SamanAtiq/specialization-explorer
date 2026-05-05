FROM public.ecr.aws/lambda/python:3.12

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt -t ${LAMBDA_TASK_ROOT}

COPY main.py ${LAMBDA_TASK_ROOT}/

RUN useradd -m appuser && chown -R appuser:appuser ${LAMBDA_TASK_ROOT}
USER appuser

CMD ["main.handler"]
