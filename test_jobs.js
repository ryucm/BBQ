import death from 'death';
import EventEmitter from 'events';
import humanize from 'humanize-duration';
import puppeteer from 'puppeteer';
import puppeteerExtra from 'puppeteer-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';

import config from '../config';
import sendSms from './sendSms';
import {
  getAnnotatedLogger,
  range,
  sum,
  delay,
  ts,
  round,
} from './util';

const defaultConsumerTimeout = 100;
const defaultStatsPrintOptions = {
  interval: 10000,
};
const defaultStatsReportOptions = null;
const maxConsecutiveFailure = 100;
const requiredBrowserOptions = {
  args: ['--no-sandbox'],
};
const defaultBrowserOptions = {
  headless: true,
  timeout: 30 * 1000,
};
const defaultPageViewport = {
  width: 1400,
  height: 900,
};
const { defaultUserAgent } = config;


class Loggable extends EventEmitter {
  constructor() {
    super();

    this.logger = null;
  }

  getLoggerName() {
    return this.constructor.name;
  }

  getLogger() {
    if (!this.logger) {
      this.logger = getAnnotatedLogger(this.getLoggerName());
    }
    return this.logger;
  }

  log = (...args) => this.getLogger().log(...args);

  silly = (...args) => this.getLogger().silly(...args);

  debug = (...args) => this.getLogger().debug(...args);

  verbose = (...args) => this.getLogger().verbose(...args);

  info = (...args) => this.getLogger().info(...args);

  warn = (...args) => this.getLogger().warn(...args);

  error = (...args) => this.getLogger().error(...args);
}


class Worker extends Loggable {
  constructor(queue, index, count, meta) {
    super();

    this.queue = queue;
    this.index = index;
    this.count = count;
    this.meta = meta;

    this.page = null;
  }

  async getPage({
    viewPort = defaultPageViewport,
    userAgent = defaultUserAgent,
  } = {}) {
    if (!this.page) {
      this.info('Opening a new page');
      this.page = await this.getNewTab();
      await this.page.setViewport(viewPort);
      await this.page.setUserAgent(userAgent);
    }
    return this.page;
  }

  async closePage() {
    if (this.page) {
      this.info('Closing a page');
      try {
        await this.page.close();
      } catch (e) {
        this.warn('Failed to properly close a page:', e);
      }
      this.page = null;
    }
  }

  async getNewTab() {
    return await (await this.queue.getBrowser()).newPage();
  }

  async getTab(tabIndex) {
    const browser = await this.queue.getBrowser();
    const pages = await browser.pages();
    let selectedTab;
    if (tabIndex < pages.length) {
      selectedTab = pages[tabIndex];
    } else {
      this.warn(`Page with tab index: ${tabIndex} doesn't exist!`);
      selectedTab = undefined;
    }
    return selectedTab;
  }
}

class Producer extends Worker {
  constructor(...args) {
    super(...args);

    this.produced = 0;
  }

  async run() {
    await this.initialize();

    try {
      await this.produce();
    } catch (e) {
      this.error('Failed to produce: ', e);
    }

    await this.finalize();

    return this.produced;
  }

  push(...jobs) {
    if (this.queue.push(...jobs)) {
      this.produced += jobs.length;
    }
  }

  isStopped() {
    return this.queue.isStopped();
  }

  isOver() {}

  async initialize() {}

  async finalize() {}

  async produce() {
    throw 'Should be implemented';
  }
}

class Consumer extends Worker {
  constructor(...args) {
    super(...args);

    this.timeout = defaultConsumerTimeout;
    this.processed = 0;
  }

  async run() {
    let consecutiveFailed = 0;

    await this.initialize();

    while (true) {
      if (this.queue.isDone()) {
        break;
      }

      if (!this.queue.isEmpty()) {
        const job = this.queue.shift();
        try {
          await this.consume(job);
          this.processed += 1;
          consecutiveFailed = 0;
        } catch (e) {
          this.error(`Failed to consume a job ${job}: `, e);
          consecutiveFailed += 1;

          if (consecutiveFailed > maxConsecutiveFailure) {
            this.error('Too many consecutive failures!');
            break;
          }
        }
      }

      await delay(this.timeout);
    }

    await this.finalize();

    return this.processed;
  }

  push(job) {
    return this.queue.push(job);
  }

  async initialize() {}

  async finalize() {}

  async consume(job) {
    throw 'Should be implemented';
  }
}

class Queue extends Loggable {
  constructor({
    name,
    producer,
    consumer,
    producerCount = 1,
    consumerCount = 1,
    producerMeta = null,
    consumerMeta = null,
    printOptions = defaultStatsPrintOptions,
    reportOptions = defaultStatsReportOptions,
    browserOptions = defaultBrowserOptions,
  }) {
    super();

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
    this.allProduced = false;
    this.stopped = false;

    this.browserOptions = {
      ...browserOptions,
      ...requiredBrowserOptions,
    };
    this.browser = null;

    this.startedAt = null;

    // Print-related
    this.statsPrintOptions = printOptions;
    this.statsPrintIntervalId = null;

    // Report-related
    this.statsReportOptions = reportOptions;
    this.statsReportIntervalId = null;
  }

  getLoggerName() {
    return this.name || super.getLoggerName();
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

  clear() {
    this.jobs = [];
  }

  isEmpty() {
    return !this.jobs.length;
  }

  isDone() {
    return this.isStopped() || (this.isEmpty() && this.allProduced);
  }

  isStopped() {
    return this.stopped;
  }

  stop() {
    this.stopped = true;
    this.clear();
    this.closeBrowser();
  }

  run() {
    death(() => {
      this.stop();
    });

    return new Promise((resolve, reject) => {
      this.startedAt = ts();

      this.statsPrintOptions && this.startStatsPrinter();
      this.statsReportOptions && this.startStatsReporter();

      this.debug(`Creating ${this.producerCount} producers`);

      Promise.all(range(this.producerCount).map((i) => {
        const producer = new this.producer(this, i, this.producerCount,
          this.producerMeta);
        this.producers.push(producer);
        return producer.run();
      })).then((counts) => {
        const total = sum(counts);
        this.debug(`Total ${total} jobs were produced.`);
        this.allProduced = true;
      });

      this.debug(`Creating ${this.consumerCount} consumers`);

      Promise.all(range(this.consumerCount).map((i) => {
        const consumer = new this.consumer(this, i, this.consumerCount,
          this.consumerMeta);
        this.consumers.push(consumer);
        return consumer.run();
      })).then((counts) => {
        const total = sum(counts);
        this.debug(`Total ${total} jobs were consumed.`);

        this.statsPrintOptions && this.stopStatsPrinter();
        this.statsReportOptions && this.stopStatsReporter();

        this.producers.forEach((producer) => {
          producer.isOver();
        });
        this.closeBrowser();
        resolve(total);
      });
    });
  }

  getStats() {
    const total = sum(this.consumers.map(consumer => consumer.processed));
    const elapsed = ts() - this.startedAt;
    const speed = round(elapsed ? total / elapsed : 0);
    const remaining = this.jobs.length;
    const etc = parseInt(speed ? this.jobs.length / speed : 0);

    const elapsedFormatted = humanize(elapsed * 1000, { largest: 2, delimiter: ' ' });
    const etcFormateed = humanize(etc * 1000, { largest: 2, delimiter: ' ' });

    return `Total ${total} consumed (Elapsed: ${elapsedFormatted}, Speed: ${speed}/s, Remaining: ${remaining}, ETC: ${etcFormateed})`;
  }

  startStatsPrinter() {
    this.statsPrintIntervalId = setInterval(
      this.printStats.bind(this),
      this.statsPrintOptions.interval,
    );
    death(this.stopStatsPrinter.bind(this));
  }

  stopStatsPrinter() {
    this.printStats();
    clearInterval(this.statsPrintIntervalId);
    this.statsPrintIntervalId = null;
  }

  printStats() {
    if (!this.statsPrintIntervalId) {
      return;
    }
    this.info(this.getStats());
  }

  startStatsReporter() {
    this.statsReportIntervalId = setInterval(
      this.reportStats.bind(this),
      this.statsReportOptions.interval,
    );
    death(this.stopStatsReporter.bind(this));
  }

  stopStatsReporter() {
    this.reportStats();
    clearInterval(this.statsReportIntervalId);
    this.statsReportIntervalId = null;
  }

  reportStats() {
    if (!this.statsReportIntervalId) {
      return;
    }
    sendSms({
      to: this.statsReportOptions.to,
      body: this.getStats(),
    });
  }

  async getBrowser() {
    if (!this.browser) {
      this.info('Launching browser');
      if (this.browserOptions.stealth) {
        puppeteerExtra.use(stealthPlugin());
        this.browser = await puppeteerExtra.launch(this.browserOptions);
      } else {
        this.browser = await puppeteer.launch(this.browserOptions);
      }
    }
    return this.browser;
  }

  async closeBrowser() {
    if (this.browser) {
      this.info('Closing browser');
      try {
        await this.browser.close();
      } catch (e) {
        this.warn('Failed to properly close browser:', e);
      }
      this.browser = null;
    }
  }
}

class HTMLProducer extends Producer {
  constructor(...args) {
    super(...args);
    this.ext = 'html';
    this.version = 1;
  }

  async produce() {
    const { date } = this.meta;
    const responseList = await this.meta.getObjectListFromS3(date, this.ext, this.version);
    for (const response of responseList) {
      this.push({ response, date });
    }
  }
}

export {
  Producer,
  Consumer,
  Queue,
  HTMLProducer,
};
