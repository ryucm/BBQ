# Crawler

## Intention of Plan
프로젝트를 기획할 때마다 필요한 Data를 크롤링 하는 상황이 빈번하게 발생했습니다.   
매번 크롤링 구조를 만드는 것보다 공통된 특징을 추출하여 구조를 정립하는 것이 효율적이라 생각하였습니다.   
또한 세부 url 수집과 data 수집의 역할 구분을 위해 Prod, Cons 디자인 컨셉을 도입하였고, Queue와 Promise를 통한 병렬처리를 진행했습니다.

## Skill

- Node.js
- babel
- cheerio
- puppeteer
- puppeteer-extra-plugin-stealth
- winston
- eslint

## Concept

Prod and Cons Using Queue
- https://velog.io/@kidae92/Apache-Kafka-%EC%A3%BC%EC%9A%94-%EC%9A%94%EC%86%8C1Producer-Consumer-Topic

## Run
- Must install npm
```js
npm i package.json
npm run crawl {sourceName}
```

## Flow

![image](https://user-images.githubusercontent.com/89899249/187604223-895a8728-8b95-461e-9ba8-41ebe78f8c6a.jpeg)

1. producer를 통해 main page에서 크롤링 할 데이터가 있는 상품의 url을 Queue에 넣는다.

![image](https://user-images.githubusercontent.com/89899249/187594801-2e412f0b-41b6-4570-85fa-9937a73720be.png)

2. consumer에서 상품의 url을 전달받아 원하는 data의 크롤링을 전달하여 Pusher에 넣는다.

![image](https://user-images.githubusercontent.com/89899249/187594979-9f547797-63cf-4c52-97c9-711d614a03d8.png)

3. Pusher에서는 endpoint로 각 data를 전달한다.

4. scheduling을 통해 주기적으로 크롤링을 실행한다.

## Implement

- Log function
- stealth in puppeteer
- asynchronous processing
- set variable endpoints
- scheduling

## Need

1. url 변경 및 기존 bot의 selector가 변경되었을 때, 알람이 오도록 만들어야 한다.

2. config를 통해 local, prod를 분리한다.

3. set DockerFile
