FROM amazon/dynamodb-local:3.1.0

USER root
RUN mkdir -p /home/dynamodblocal/data && chown dynamodblocal:dynamodblocal /home/dynamodblocal/data

USER dynamodblocal
