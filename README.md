# Using the docker image
```dockerfile
FROM flaire/synchrome

RUN mkdir -pv /home/app
ADD . /home/app
RUN cd /home/app && npm i

WORKDIR /home/app
ENTRYPOINT ["npm", "start"]
```