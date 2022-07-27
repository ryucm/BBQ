import delay from 'delay';
import EventEmitter from 'events';
import puppeteer from 'puppeteer';
import puppeteerExtra from 'puppeteer-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import {
  range
} from './util';

class Worker extends EventEmitter {
  constructor(queue, count, meta) {
    super();

    this.queue = queue;
    this.count = count;
    this.meta = meta;

    this.page = null;
    this.browser = null;
  }

  async startPage({
    viewPort = { width: 1920, height: 1080 },
    userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/103.0.0.0 Safari/537.36',
  } = {}) {
    if (!this.browser) {
      if (this.browserOptions.stealth) {
        puppeteerExtra.use(stealthPlugin());
        this.browser = await puppeteerExtra.launch(this.browserOptions);
      } else {
        this.browser = await puppeteer.launch(this.browserOptions);
      }
    }
    
    this.page = await this.browser.newPage();
    await this.page.setViewport(viewPort);
    await this.page.setUserAgent(userAgent);
    return this.page;
  }
}

class Producer extends Worker {
  constructor(...args) {
    super(...args);

    this.produced = 0;
  }

  static pageStart = 1;

  static pageMax = 30;

  static pageStep = 1;

  async run() {
    try{
      await this.produce();
      
    } catch (e) {
      console.log('Fail produce: ', e);
    }
    
    return this.produced;
  }

  push(...jobs) {
    if(this.queue.push(...jobs)) {
      this.produced += jobs.length;
    };
  }

  async produce() {
    throw 'Should be implemented';
  }
}

class Consumer extends Worker {
  constructor(...args){
    super(...args);

    this.processed = 0;
    this.maxFailCount = 30;
  }

  async run() {
    let failCount = 0;
    while (!this.allProduce) {
      if (!this.queue.isEmpty()) {
        const job = this.queue.shift();
        try {
          await this.consume(job);
          this.processed += 1;
          failCount = 0;
        } catch (e) {
          console.log(`Failed consume ${job}: `, e);
          failCount += 1;
  
          if (failCount > maxFailCount) {
            console.log('Too many consecutive failures!');
            break;
          }
        }
      }
      await delay(1000);
      
    }
    return this.processed;
  }

  async consume(job) {
    throw 'Should be implemented';
  }
}

class Queue {
  constructor({
    name,
    producer,
    consumer,
    producerCount = 1,
    consumerCount = 1,
    producerMeta = null,
    consumerMeta = null,
    browserOptions = { headless: true, timeout: 30000 },
  }) {
    this.name = name;
    this.producer = producer;
    this.consumer = consumer;
    this.producers = [];
    this.consumers = [];
    this.producerCount = producerCount;
    this.consumerCount = consumerCount;
    this.producerMeta = producerMeta;
    this.consumerMeta = consumerMeta;
    this.jobs = [];
    this.browserOptions = {
      ...browserOptions,
    };
    this.allProduce = false;
  }

  shift(...args) {
    return this.jobs.shift(...args);
  }

  unshift(...args) {
    return this.jobs.unshift(...args);
  }

  push(...args) {
    return this.jobs.push(...args);
  }

  isEmpty() {
    return !this.jobs.length;
  }

  run() {
    return new Promise((resolve, reject) => {
      Promise.all(range(this.producerCount).map((_) => {
        console.log(`Creating ${this.producerCount} producers`);
        const producer = new this.producer(this, this.producerCount, this.producerMeta);
        this.producers.push(producer);
        return producer.run();
      })).then((counts) => {
        const total = counts;
        console.log(`Total ${total} jobs were produced.`);
        this.allProduce = true;
      });

      Promise.all(range(this.consumerCount).map((_) => {
        console.log(`Creating ${this.consumerCount} consumer`);
        const consumer = new this.consumer(this, this.consumerCount, this.consumerMeta);
        return consumer.run();
      })).then((counts) => {
        const total = counts;
        console.log(`Total ${total} jobs were consumed.`);
        resolve(total);
      });
    })
  }
}

async function push(queue) {
  console.log(queue);
  console.log(`Completing`);
  // kafka로 넘기는 곳
}

class Pusher {
  static bufferSize = 100;

  constructor(name, defaults) {
    this.name = name;
    this.defaults = {
      ...defaults,
    }
    this.buffer = [];
    this.count = 0;
  }

  async push(clothes) {
    console.log(`Buffering ${clothes.length} clothes`);

    this.count += clothes.length;
    this.buffer = this.buffer.concat(clothes);

    if (this.buffer.length > this.constructor.bufferSize) {
      await this.flush();
    }
  }

  async complete() {
    if (!this.count) {
      console.log('Nothing to complete');
      return;
    }

    await this.flush();
    await complete();
  }

  async flush() {
    if (!this.buffer.length) {
      return;
    }

    const data = this.buffer;
    this.buffer = [];

    console.log(`Flushing ${data.length} buffered prices`);

    const size = this.constructor.bufferSize;
    const queue = [];

    while (data.length > 0) {
      queue.push(data.shift());
      if (!data.length || queue.length === size) {
        const result = await push(queue);
        if (result) {
          console.log('Successfully flushed:', result);
        }
        queue.length = 0;
      }
    }
  }
}

export {
  Producer,
  Consumer,
  Queue,
  Pusher,
};