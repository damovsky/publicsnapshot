import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as path from 'path';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { PolicyStatement, Effect, AnyPrincipal } from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as targetsroute53 from 'aws-cdk-lib/aws-route53-targets';



export class PublicSnapshotsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
 
    // Define the list of AWS regions you want to process
    const awsRegions = [
      'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
      'eu-west-1', 'eu-central-1', 'ap-southeast-1', 'ap-southeast-2',
      'ap-northeast-1', 'sa-east-1'
    ];
    const domainName = 'awspublicsnapshot.com';
    const wwwDomainName = `www.${domainName}`;


    // Create DynamoDB table
    const table = new dynamodb.Table(this, 'EC2PublicSnapshotTable', {
      partitionKey: { name: 'snapshotId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'awsRegion', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // NOTE: Set to RETAIN in production
    });

    // Create Lambda Layer for X-Ray SDK
    const xrayLayer = new lambda.LayerVersion(this, 'XRayLayer', {
      code: lambda.Code.fromAsset('lambda_layer'),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_9],
      description: 'X-Ray SDK Layer',
    });

    // Create Lambda function
    const snapshotLambda = new lambda.Function(this, 'SnapshotLambda', {
      runtime: lambda.Runtime.PYTHON_3_9,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda'),
      timeout: cdk.Duration.seconds(300),
      memorySize: 3000, 
      environment: {
        TABLE_NAME: table.tableName,
      },
      tracing: lambda.Tracing.ACTIVE,
      layers: [xrayLayer],
    });

    // Grant Lambda function read/write permissions to DynamoDB table
    table.grantReadWriteData(snapshotLambda);
    // Grant privileges to scan table
    table.grantReadData(snapshotLambda);

    // Grant Lambda function permissions to describe EC2 and RDS snapshots
    snapshotLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:DescribeSnapshots',
        'rds:DescribeDBSnapshots',
        'rds:DescribeDBClusterSnapshots',
      ],
      resources: ['*'],
    }));

    // // Create EventBridge rule to trigger Lambda every hour
    // new events.Rule(this, 'HourlySnapshotRule', {
    //   schedule: events.Schedule.rate(cdk.Duration.hours(1)),
    //   targets: [new targets.LambdaFunction(snapshotLambda)],
    // });
    // Create a Task to invoke the Lambda function
    const invokeLambda = new tasks.LambdaInvoke(this, 'InvokeLambdaTask', {
      lambdaFunction: snapshotLambda,
      payloadResponseOnly: true,
      payload: sfn.TaskInput.fromObject({
        'region': sfn.JsonPath.stringAt('$')
      }),
    }).addRetry({
      maxAttempts: 5,
      interval: cdk.Duration.seconds(30),
      backoffRate: 2
    });

    // Create a Map state to iterate through the regions
    const mapState = new sfn.Map(this, 'ProcessRegions', {
      maxConcurrency: 5, // Adjust as needed
      itemsPath: sfn.JsonPath.stringAt('$.regions'),
    });
    mapState.iterator(invokeLambda);

    // Create the state machine
    const stateMachine = new sfn.StateMachine(this, 'ProcessRegionsStateMachine', {
      definition: mapState,
      tracingEnabled: true, // Enable X-Ray tracing

    });

    // Create EventBridge rule to trigger Step Functions every hour
    new events.Rule(this, 'HourlySnapshotRule', {
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      targets: [new targets.SfnStateMachine(stateMachine, {
        input: events.RuleTargetInput.fromObject({
          regions: awsRegions
        }),
      })],
    });

    // Grant X-Ray permissions to Lambda
    snapshotLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'xray:PutTraceSegments',
        'xray:PutTelemetryRecords',
      ],
      resources: ['*'],
    }));


    // New Lambda function for querying DynamoDB
    const queryLambda = new lambda.Function(this, 'QueryLambda', {
      runtime: lambda.Runtime.PYTHON_3_9,
      handler: 'index.lambda_handler',
      code: lambda.Code.fromAsset('lambda-query'),
      environment: {
        TABLE_NAME: table.tableName,
      },
    });

    // Grant the Lambda function read access to the DynamoDB table
    table.grantReadData(queryLambda);
    // Grant Lambda function read/write permissions to DynamoDB table
    table.grantReadWriteData(queryLambda);

    // Create API Gateway with explicit CORS configuration
    const api = new apigateway.RestApi(this, 'SnapshotsApi', {
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'X-Amz-Date', 'Authorization', 'X-Api-Key'],
        allowCredentials: true,
      },
    });

    // Add a GET method to the root of the API
    const integration = new apigateway.LambdaIntegration(queryLambda, {
      proxy: true,
      // Ensure proper handling of CORS headers
      integrationResponses: [{
        statusCode: '200',
        responseParameters: {
          'method.response.header.Access-Control-Allow-Origin': "'*'",
        },
      }],
    });

    api.root.addMethod('GET', integration, {
      methodResponses: [{
        statusCode: '200',
        responseParameters: {
          'method.response.header.Access-Control-Allow-Origin': true,
        },
      }],
    });

    const snapshots = api.root.addResource('snapshots');
    snapshots.addMethod('GET', new apigateway.LambdaIntegration(queryLambda));

    // S3 bucket for website hosting with correct public access configuration
    const websiteBucket = new s3.Bucket(this, 'WebsiteBucket', {
      websiteIndexDocument: 'index.html',
      publicReadAccess: true,
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: false,
        blockPublicPolicy: false,
        ignorePublicAcls: false,
        restrictPublicBuckets: false
      }),
      removalPolicy: cdk.RemovalPolicy.DESTROY, // For easy cleanup, change for production
      autoDeleteObjects: true // For easy cleanup, change for production
    });

    // Add bucket policy to allow public read access
    websiteBucket.addToResourcePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['s3:GetObject'],
      resources: [websiteBucket.arnForObjects('*')],
      principals: [new AnyPrincipal()],
    }));

    // // // Deploy the website to S3
    // new s3deploy.BucketDeployment(this, 'DeployWebsite', {
    //   sources: [s3deploy.Source.asset('website')],
    //   destinationBucket: websiteBucket,
    // });


    // Get the hosted zone for your domain
    const zone = route53.HostedZone.fromLookup(this, 'Zone', {
      domainName: domainName,
    });

    // Create a certificate for HTTPS
    const certificate = new acm.DnsValidatedCertificate(this, 'SiteCertificate', {
      domainName: domainName,
      subjectAlternativeNames: [wwwDomainName],
      hostedZone: zone,
      region: 'us-east-1', // Cloudfront only checks this region for certificates
    });


    // CloudFront distribution
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: new origins.S3Origin(websiteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      domainNames: [domainName, wwwDomainName],
      certificate: certificate,
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
        },
      ],
    });

    // Deploy website contents to S3
    new s3deploy.BucketDeployment(this, 'DeployWebsite', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', 'snapshot-viewer', 'build'))],
      destinationBucket: websiteBucket,
      distribution,
      distributionPaths: ['/*'],
      // Force deployment by adding a timestamp
      // metadata: { timestamp: new Date().toISOString() }
    });

    // Route53 alias record for the CloudFront distribution
    new route53.ARecord(this, 'SiteAliasRecord', {
      recordName: domainName,
      target: route53.RecordTarget.fromAlias(new targetsroute53.CloudFrontTarget(distribution)),
      zone
    });

    // Route53 alias record for the CloudFront distribution (www subdomain)
    new route53.ARecord(this, 'WwwSiteAliasRecord', {
      recordName: wwwDomainName,
      target: route53.RecordTarget.fromAlias(new targetsroute53.CloudFrontTarget(distribution)),
      zone
    });



    // Output the website URL and API endpoint
    new cdk.CfnOutput(this, 'WebsiteUrl', {
      value: websiteBucket.bucketWebsiteUrl,
      description: 'URL for website hosted on S3',
    });

    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: api.url,
      description: 'API Gateway endpoint URL',
    });
  }
}