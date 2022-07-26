
import request from 'request-promise';
import * as cheerio from 'cheerio';
import {
  Producer,
  Consumer,
} from '../../lib/jobs';
import { Crawler } from '../../lib/crawler'
const baseUrl = 'http://mahagrid.com';
class MahagridProducer extends Producer {
  async produce() {
    let response;
    const pageUrl = `${baseUrl}/product/list.html?cate_no=24&page=1`;
    try {
      response = await request(pageUrl);
      console.log(`producing : ${pageUrl}`);
    } catch (e) {
      console.log(e);
    }
    const $ = cheerio.load(response);
    $('.mun-prd-thumb > a').each((_i,el) => {
      const url = $(el).attr('href');
      this.push(url);
    })
  }
}

class MahagridConsumer extends Consumer {
  async consume(url) {
    // console.log(`consuming ${url}`);
    this.meta.pusher.push(url);
  }
}

export default new Crawler({
  name: 'Maha Grid',
  defaults: {
    description: 'Maha Grid',
   url: 'http://mahagrid.com',
    country: 'kr',
    currency: 'W',
    language: 'kr',
  },
  queueOptions: {
    producer: MahagridProducer,
    consumer: MahagridConsumer,
    producerCount: 1,
    consumerCount: 1,
    // browserOptions: {
    //   headless: true,
    // }
  }
});