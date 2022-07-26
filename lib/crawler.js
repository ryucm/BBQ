import {
  Pusher,
  Queue,

} from "./jobs";
import assert from 'assert';
import axios from 'axios';

export class Crawler {
    constructor({
      name,
      defaults,
      queueOptions,
    }) {
      this.name = name;
      this.defaults = defaults;
      this.queueOptions = {
          name: this.name,
          ...queueOptions,
      };
    }

    async crawl() {
      console.log(`Start crawling ${this.name}`);

      const pusher = new Pusher(
        this.name, {...this.defaults}
      );
      const queue = new Queue({
        ...this.queueOptions,
        producerMeta: {
          ...(this.queueOptions.producerMeta || {}),
        },
        consumerMeta: {
          pusher,
          ...(this.queueOptions.consumerMeta || {}),
        },
      });

      try {
        await queue.run();
      } catch (e) {
        console.log('Failed to run a queue: ', e);
      }

      await pusher.complete();

      const { count } = pusher;

      return count;
    }
}