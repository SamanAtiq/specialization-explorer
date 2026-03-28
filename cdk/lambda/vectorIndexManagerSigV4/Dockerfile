FROM public.ecr.aws/lambda/python:3.12

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt -t ${LAMBDA_TASK_ROOT}

COPY main.py ${LAMBDA_TASK_ROOT}/

CMD ["main.handler"]
