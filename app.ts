import { App } from 'aws-cdk-lib';
import { CDKWebhook } from './stack';

const app = new App();

new CDKWebhook(app, 'CDKWebhook', {
  env: {
    account: process.env.AWS_ACCOUNT_ID,
    region: process.env.AWS_REGION,
  },
});
