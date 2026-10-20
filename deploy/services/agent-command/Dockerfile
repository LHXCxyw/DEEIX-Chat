# 默认使用公开 Python 基础镜像；管理员仍可通过 --build-arg 覆盖为审核过的 digest 镜像。
ARG BASE_IMAGE=python:3.12-slim-bookworm
FROM ${BASE_IMAGE}

ENV PYTHONDONTWRITEBYTECODE=1
LABEL io.deeix.agent.runner="deeix-agent-command" \
      io.deeix.agent.runner-version="1.0.0" \
      io.deeix.agent.protocol="1"
COPY --chown=0:0 runner.py /opt/deeix/runner.py
# 任务容器以 UID 65532 运行，必须能遍历 /opt/deeix 并读取入口文件。
RUN chmod 0755 /opt/deeix && chmod 0444 /opt/deeix/runner.py
USER 65532:65532
WORKDIR /workspace
HEALTHCHECK --interval=30s --timeout=3s --retries=1 CMD ["/usr/local/bin/python3", "-I", "/opt/deeix/runner.py", "--healthcheck"]
ENTRYPOINT ["/usr/local/bin/python3", "-I", "/opt/deeix/runner.py"]
CMD []
