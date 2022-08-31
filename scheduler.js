import schedule from 'node-schedule';
import AWS from 'aws-sdk';

import config from 'config';

const tasks = [
  ['00 05 00 * * *', 'mahagrid'],
];

const addJob = (path, jobOptions) => {
  AWS.config.update({ region: config.awsRegionSG });
  const batch = new AWS.Batch();
  const [, args] = path.split('/');
  const [jobName] = args.split(' ');

  const {
    resourceSize = 'small',
    timeout = config.awsBatchDefaultTimeout,
  } = jobOptions || {};
  const { memory, vcpu } = config.awsBatchResource[resourceSize];

  const jobDefinition = config.awsBatchJobDefinitionArn;

  const options = {
    jobName,
    jobDefinition,
    jobQueue: config.awsBatchJobQueueArn,
    containerOverrides: {
      command: ['npm', 'run', 'crawl', '--', ...path.split(' ')],
      environment: [{
        name: 'NODE_ENV',
        value: process.env.NODE_ENV || 'local',
      }],
      resourceRequirements: [
        {
          type: 'MEMORY',
          value: memory,
        },
        {
          type: 'VCPU',
          value: vcpu,
        },
      ],
    },
    timeout: {
      attemptDurationSeconds: timeout,
    },
  };

  batch.submitJob(options, (err, data) => {
    if (err) {
      console.error(err);
    } else {
      console.info(data);
    }
  });
};

tasks.forEach((task) => {
  const [conf, path, options] = task;

  console.info(`Reserving \`${conf}\` for \`${path}\``);

  schedule.scheduleJob(conf, () => {
    console.info(`Running ${path}`);

    addJob(path, options);
  });
});
