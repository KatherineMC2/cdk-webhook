import {
  type App,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from 'aws-cdk-lib';
import {
  Model,
  PassthroughBehavior,
  RestApi,
} from 'aws-cdk-lib/aws-apigateway';
import { Code, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { userSchema } from './src/schema/user';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import {
  CloudwatchLogsLogDestination,
  DesiredState,
  LogLevel as PipesLogLevel,
  Pipe,
} from '@aws-cdk/aws-pipes-alpha';
import { SqsSource } from '@aws-cdk/aws-pipes-sources-alpha';
import {
  SfnStateMachine,
  StateMachineInvocationType,
} from '@aws-cdk/aws-pipes-targets-alpha';
import {
  Effect,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from 'aws-cdk-lib/aws-iam';
import {
  DefinitionBody,
  LogLevel,
  Pass,
  StateMachine,
  StateMachineType,
} from 'aws-cdk-lib/aws-stepfunctions';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { LambdaInvoke } from 'aws-cdk-lib/aws-stepfunctions-tasks';

export class CDKWebhook extends Stack {
  constructor(scope: App, id: string, props: StackProps) {
    super(scope, id, props);

    /* ----------------- SQS ----------------- */
    const dlq = new Queue(this, 'WebhookDLQ', {
      queueName: 'webhook-dlq',
      retentionPeriod: Duration.days(14),
    });

    const webhookQueue = new Queue(this, 'WebhookQueue', {
      deadLetterQueue: {
        queue: dlq,
        maxReceiveCount: 3,
      },
      queueName: 'webhook-queue',
      retentionPeriod: Duration.days(7),
    });

    const myRequestJsonSchema = zodToJsonSchema(userSchema, {
      target: 'openApi3',
    });

    /* ----------------- API Gateway ----------------- */

    // We create an API Gateway
    const myWebhookAPI = new RestApi(this, 'MyAPI', {
      restApiName: 'my-webhook-api',
    }); 

    // We create a Role for the API Gateway to be able to send messages to the SQS queue
    const webhookSubscriptionAPIRole = new Role(
      this,
      'WebhookSubscriptionApiRole',
      {
        assumedBy: new ServicePrincipal('apigateway.amazonaws.com'),
        inlinePolicies: {
          sqsSendMessage: new PolicyDocument({
            statements: [
              new PolicyStatement({
                actions: ['sqs:SendMessage'],
                effect: Effect.ALLOW,
                resources: [webhookQueue.queueArn],
              }),
            ],
          }),
        },
      },
    );

    const sqsIntegration = new apigateway.AwsIntegration({
      integrationHttpMethod: 'POST',
      options: {
        credentialsRole: webhookSubscriptionAPIRole,
        passthroughBehavior: PassthroughBehavior.NEVER,
        integrationResponses: [
          {
            responseTemplates: {
              'application/json': '{}',
            },
            statusCode: '200',
          },
        ],
        requestParameters: {
          'integration.request.header.Content-Type': `'application/x-www-form-urlencoded'`,
        },
        // We extract the body from the request and send it to the SQS queue
        requestTemplates: {
          'application/json':
            'Action=SendMessage&MessageBody={"body": $util.urlEncode($input.body)}',
        },
      },
      path: `${this.account}/${webhookQueue.queueName}`,
      region: this.region,
      service: 'sqs',
    });

    // Add the POST method to the API Gateway with the SQS integration and the request validator
    myWebhookAPI.root.addMethod('POST', sqsIntegration, {
      requestValidatorOptions: {
        requestValidatorName: 'webhook-request-validator',
        validateRequestBody: true,
      },
      requestModels: {
        'application/json': new Model(this, 'webhook-request-model', {
          restApi: myWebhookAPI,
          contentType: 'application/json',
          description: 'Validation model for the request body',
          modelName: 'myRequestJsonSchema',
          schema: myRequestJsonSchema,
        }),
      },
      methodResponses: [
        {
          statusCode: '200',
          responseModels: {
            'application/json': Model.EMPTY_MODEL,
          },
        },
        {
          statusCode: '400',
          responseModels: {
            'application/json': Model.ERROR_MODEL,
          },
        },
        {
          statusCode: '500',
          responseModels: {
            'application/json': Model.ERROR_MODEL,
          },
        },
      ],
    });

    myWebhookAPI.addGatewayResponse('ValidationError', {
      type: apigateway.ResponseType.BAD_REQUEST_BODY,
      statusCode: '400',
      templates: {
        'application/json': JSON.stringify({
          errors: '$context.error.validationErrorString',
          details: '$context.error.message',
        }),
      },
    });

    /* ----------------- Step Function ----------------- */
    const validateMessageLambda = new NodejsFunction(
      this,
      'ValidateMessageLambda',
      {
        code: Code.fromInline(`
        exports.handler = async (event) => {
            console.log('Validating message');
            console.log(JSON.parse(event[0].body)); 
            return true;
          };
        `),
        handler: 'index.handler',
        runtime: Runtime.NODEJS_22_X,
      },
    );

    const myStepFunction = new StateMachine(this, 'MyStepFunction', {
      stateMachineType: StateMachineType.EXPRESS,
      logs: {
        destination: new LogGroup(this, 'MyStepFunctionLogs', {
          logGroupName: '/aws/vendedlogs/states/my-step-function-logs',
          removalPolicy: RemovalPolicy.DESTROY,
          retention: RetentionDays.ONE_DAY,
        }),
        level: LogLevel.ALL,
      },
      definitionBody: DefinitionBody.fromChainable(
        new LambdaInvoke(this, 'ValidateMessageTask', {
          lambdaFunction: validateMessageLambda,
          comment: 'Validate the message',
          stateName:
            'Validate Message (HMAC Signature, Basic Authentication, etc)',
        }).next(
          new Pass(this, 'ProcessMessageTask', {
            stateName: 'Process Message',
          }),
        ),
      ),
    });

    /* ----------------- Pipe ----------------- */
    const myIstateMachine = StateMachine.fromStateMachineArn(
      this,
      'myIStateMachine',
      myStepFunction.stateMachineArn,
    );
    new Pipe(this, 'MyPipe', {
      source: new SqsSource(webhookQueue),
      target: new SfnStateMachine(myIstateMachine, {
        invocationType: StateMachineInvocationType.REQUEST_RESPONSE,
      }),
      // Configure the pipe to send logs to CloudWatch Logs
      logLevel: PipesLogLevel.TRACE,
      logDestinations: [
        new CloudwatchLogsLogDestination(
          new LogGroup(this, 'PipeLogs', {
            logGroupName: '/aws/vendedlogs/states/pipe-logs',
            removalPolicy: RemovalPolicy.DESTROY,
            retention: RetentionDays.ONE_DAY,
          }),
        ),
      ],
      desiredState: DesiredState.RUNNING,
    });
  }
}
