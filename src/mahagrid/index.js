
import request from 'request'
import  { cheerio } from 'cheerio';
import {
  Producer,
  Consumer,
} from '../../lib/jobs';
import { Crawler } from '../../lib/crawler'

class MahagridProducer extends Producer {
  async produce() {
    const baseUrl = 'http://mahagrid.com';
    let response;
    response = await request(`${baseUrl}/product/list.html?cate_no=24&page=1`);
    const $ = cheerio.load(response);
    $('.mun-prd-thumb > a').each((_i,el) => {
      console.log($(el).text().trim());
      this.push($(el).attr('href'))
    })
    return;
  }
}

class MahagridConsumer extends Consumer {
  async consume(job) {
    return;
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
    browserOptions: {
      headless: true,
    }
  }
});