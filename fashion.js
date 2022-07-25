
import request from 'request-promise'
import cheerio from 'cheerio';
import {
  Producer,
  Consumer,
} from './lib/jobs';
import Crawler from './lib/crawler'

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

export default new Crawler ({
  
})