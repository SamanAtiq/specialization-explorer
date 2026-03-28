import * as cdk from "aws-cdk-lib";
import { Stack, StackProps, CfnOutput, RemovalPolicy } from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as opensearchserverless from "aws-cdk-lib/aws-opensearchserverless";
import { Construct } from "constructs";
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
  Provider,
} from "aws-cdk-lib/custom-resources";

// Fallback placeholder URL if SSM parameter doesn't exist
const FALLBACK_URL = ["https://example.com"];
const WEB_CRAWLER_URLS_PARAM = "/SpecEx/KnowledgeBase/WebCrawlerUrls";

// Bedrock KB / AOSS index settings
const VECTOR_INDEX_NAME = "bedrock-knowledge-base-default-index";
const VECTOR_FIELD_NAME = "bedrock-knowledge-base-default-vector";
const TEXT_FIELD_NAME = "AMAZON_BEDROCK_TEXT_CHUNK";
const METADATA_FIELD_NAME = "AMAZON_BEDROCK_METADATA";
const EMBEDDING_MODEL_ID = "cohere.embed-english-v3";
const COHERE_V3_DIMENSIONS = 1024;

export interface KnowledgeBaseStackProps extends StackProps {
  stackPrefix: string;
  vectorIndexManagerRepository: ecr.IRepository;
  vectorIndexManagerPipelineName: string;
}

export class KnowledgeBaseStack extends Stack {
  public readonly knowledgeBaseBucket: s3.Bucket;
  public readonly vectorCollection: opensearchserverless.CfnCollection;
  public readonly knowledgeBaseId: string;
  public readonly s3DataSourceId: string;
  public readonly webCrawlerDataSourceId: string;

  constructor(scope: Construct, id: string, props: KnowledgeBaseStackProps) {
    super(scope, id, props);

    // Keep name very short to avoid 32 character limit on AOSS Collection & Policy Names
    // e.g. "specex-kb"
    const rawPrefix = props.stackPrefix.toLowerCase().substring(0, 6);
    const stableSuffix = this.node.addr.substring(0, 6);
    const collectionName = `${rawPrefix}-kb-${stableSuffix}`;
    
    // We also use shorter suffixes for policies: `-enc`, `-net`, `-acc`
    const embeddingModelArn = `arn:aws:bedrock:${this.region}::foundation-model/${EMBEDDING_MODEL_ID}`;

    // Account-level capacity limits set to minimum 2/2 OCUs
    new AwsCustomResource(this, "OSSCapacityLimits", {
      onCreate: {
        service: "OpenSearchServerless",
        action: "updateAccountSettings",
        parameters: {
          capacityLimits: { maxIndexingCapacityInOCU: 2, maxSearchCapacityInOCU: 2 },
        },
        physicalResourceId: PhysicalResourceId.of("oss-capacity-limits"),
      },
      onUpdate: {
        service: "OpenSearchServerless",
        action: "updateAccountSettings",
        parameters: {
          capacityLimits: { maxIndexingCapacityInOCU: 2, maxSearchCapacityInOCU: 2 },
        },
        physicalResourceId: PhysicalResourceId.of("oss-capacity-limits"),
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });

    // Create encryption policy for OpenSearch Serverless
    const encryptionPolicy = new opensearchserverless.CfnSecurityPolicy(this, "EncryptionPolicy", {
      name: `${collectionName}-enc`,
      type: "encryption",
      policy: JSON.stringify({
        Rules: [{ ResourceType: "collection", Resource: [`collection/${collectionName}`] }],
        AWSOwnedKey: true,
      }),
    });

    // Create network policy for OpenSearch Serverless
    const networkPolicy = new opensearchserverless.CfnSecurityPolicy(this, "NetworkPolicy", {
      name: `${collectionName}-net`,
      type: "network",
      policy: JSON.stringify([{
        Rules: [
          { ResourceType: "collection", Resource: [`collection/${collectionName}`] },
          { ResourceType: "dashboard", Resource: [`collection/${collectionName}`] },
        ],
        AllowFromPublic: false,
      }]),
    });

    // IAM role for Bedrock Knowledge Base
    const knowledgeBaseRole = new iam.Role(this, "KnowledgeBaseRole", {
      assumedBy: new iam.ServicePrincipal("bedrock.amazonaws.com"),
      description: "Role for Bedrock Knowledge Base to access OpenSearch and S3",
    });

    // IAM role for custom resource that manages AOSS vector index
    const vectorIndexManagerRole = new iam.Role(this, "VectorIndexManagerRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: "Execution role for custom resource that creates AOSS vector index",
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")],
    });
    vectorIndexManagerRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["aoss:APIAccessAll", "aoss:DashboardsAccessAll"],
      resources: ["*"],
    }));

    // Vector collection
    this.vectorCollection = new opensearchserverless.CfnCollection(this, "VectorCollection", {
      name: collectionName,
      type: "VECTORSEARCH",
      description: "Vector collection for Bedrock Knowledge Base",
    });

    // Bedrock role IAM permissions
    knowledgeBaseRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["aoss:APIAccessAll", "aoss:DashboardsAccessAll"],
      resources: [this.vectorCollection.attrArn],
    }));

    knowledgeBaseRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["bedrock:InvokeModel"],
      resources: [embeddingModelArn],
    }));

    this.knowledgeBaseBucket = new s3.Bucket(this, "KnowledgeBaseBucket", {
      bucketName: `${props.stackPrefix.toLowerCase()}-kb-documents-bucket`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true,
      cors: [{
        allowedHeaders: ["*"],
        allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.POST, s3.HttpMethods.DELETE],
        allowedOrigins: ["*"], // TODO: restrict in production
        exposedHeaders: ["ETag"],
      }],
    });

    // Grant Bedrock role permissions to read from S3
    this.knowledgeBaseBucket.grantRead(knowledgeBaseRole);

    // Ensure the vector index manager container image exists in ECR before creating the image-based Lambda.
    const ecrImageWaiterRole = new iam.Role(this, "KBEcrImageWaiterRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });

    ecrImageWaiterRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ecr:DescribeImages", "ecr:DescribeRepositories", "ecr:BatchGetImage"],
      resources: [props.vectorIndexManagerRepository.repositoryArn],
    }));

    ecrImageWaiterRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["codepipeline:StartPipelineExecution"],
      resources: [
        `arn:aws:codepipeline:${this.region}:${this.account}:${props.vectorIndexManagerPipelineName}`,
      ],
    }));

    ecrImageWaiterRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
      resources: ["arn:aws:logs:*:*:*"],
    }));

    const ecrImageWaiterFn = new lambda.Function(this, "KBEcrImageWaiterFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      role: ecrImageWaiterRole,
      timeout: cdk.Duration.minutes(15),
      code: lambda.Code.fromAsset("lambda/ecrImageWaiter"),
    });

    const ecrImageWaiter = new cdk.CustomResource(this, "KBEcrImageWaiter", {
      serviceToken: ecrImageWaiterFn.functionArn,
      properties: {
        RepositoryName: props.vectorIndexManagerRepository.repositoryName,
        ImageTag: "latest",
        MaxRetries: "28",
        RetryDelaySeconds: "30",
        CodePipelineName: props.vectorIndexManagerPipelineName,
        TriggerBuildOnMissing: "true",
      },
    });

    // Vector Index Manager Lambda
    const vectorIndexManagerFn = new lambda.DockerImageFunction(this, "VectorIndexManagerFn", {
      role: vectorIndexManagerRole,
      timeout: cdk.Duration.minutes(15),
      memorySize: 512,
      functionName: `${props.stackPrefix}-KnowledgeBase-VectorIndexManagerFn`,
      code: lambda.DockerImageCode.fromEcr(props.vectorIndexManagerRepository, {
        tagOrDigest: "latest",
      }),
    });
    vectorIndexManagerFn.node.addDependency(ecrImageWaiter);

    const vectorIndexProvider = new Provider(this, "VectorIndexProvider", {
      onEventHandler: vectorIndexManagerFn,
    });

    // OpenSearch Serverless data access policy
    const dataAccessPolicy = new opensearchserverless.CfnAccessPolicy(this, "DataAccessPolicy", {
      name: `${collectionName}-acc`,
      type: "data",
      policy: JSON.stringify([{
        Rules: [
          {
            ResourceType: "collection",
            Resource: [`collection/${collectionName}`],
            Permission: ["aoss:CreateCollectionItems", "aoss:DeleteCollectionItems", "aoss:UpdateCollectionItems", "aoss:DescribeCollectionItems"],
          },
          {
            ResourceType: "index",
            Resource: [`index/${collectionName}/*`],
            Permission: [
              "aoss:CreateIndex", "aoss:DeleteIndex", "aoss:UpdateIndex",
              "aoss:DescribeIndex", "aoss:ReadDocument", "aoss:WriteDocument"
            ],
          },
        ],
        Principal: [knowledgeBaseRole.roleArn, vectorIndexManagerRole.roleArn],
      }]),
    });

    this.vectorCollection.addDependency(encryptionPolicy);
    this.vectorCollection.addDependency(networkPolicy);
    this.vectorCollection.addDependency(dataAccessPolicy);

    const vectorIndexCustomResource = new cdk.CustomResource(this, "VectorIndexCustomResource", {
      serviceToken: vectorIndexProvider.serviceToken,
      properties: {
        CollectionEndpoint: this.vectorCollection.attrCollectionEndpoint,
        Region: this.region,
        IndexName: VECTOR_INDEX_NAME,
        VectorField: VECTOR_FIELD_NAME,
        TextField: TEXT_FIELD_NAME,
        MetadataField: METADATA_FIELD_NAME,
        Dimensions: COHERE_V3_DIMENSIONS,
      },
    });

    vectorIndexCustomResource.node.addDependency(this.vectorCollection);
    vectorIndexCustomResource.node.addDependency(networkPolicy);
    vectorIndexCustomResource.node.addDependency(dataAccessPolicy);
    vectorIndexCustomResource.node.addDependency(vectorIndexManagerRole);
    vectorIndexProvider.node.addDependency(networkPolicy);
    vectorIndexProvider.node.addDependency(dataAccessPolicy);

    let webCrawlerUrls: string;
    try {
      webCrawlerUrls = ssm.StringParameter.valueFromLookup(this, WEB_CRAWLER_URLS_PARAM);
    } catch {
      webCrawlerUrls = FALLBACK_URL.join(",");
    }

    // Role for Knowledge Base Provisioner Lambda
    const kbProvisionerRole = new iam.Role(this, "KBProvisionerRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: "Execution role for custom resource that creates the Bedrock Knowledge Base and Data Sources",
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")],
    });

    kbProvisionerRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        "bedrock:CreateKnowledgeBase",
        "bedrock:GetKnowledgeBase",
        "bedrock:UpdateKnowledgeBase",
        "bedrock:DeleteKnowledgeBase",
        "bedrock:CreateDataSource",
        "bedrock:ListDataSources",
        "bedrock:UpdateDataSource",
        "bedrock:DeleteDataSource",
        "iam:PassRole"
      ],
      resources: [knowledgeBaseRole.roleArn], 
      conditions: {
        StringEquals: {
          "iam:PassedToService": "bedrock.amazonaws.com"
        }
      }
    }));

    const kbProvisionerFn = new lambda.Function(this, "KBProvisionerFn", {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "main.handler",
      role: kbProvisionerRole,
      timeout: cdk.Duration.minutes(15),
      memorySize: 512,
      code: lambda.Code.fromAsset("lambda/knowledgeBaseProvisioner"),
    });

    const kbProvisionerProvider = new Provider(this, "KBProvisionerProvider", {
      onEventHandler: kbProvisionerFn,
    });

    // Create the Bedrock Knowledge Base using the Custom Resource Lambda
    const kbCustomResource = new cdk.CustomResource(this, "KnowledgeBaseProvisioner", {
      serviceToken: kbProvisionerProvider.serviceToken,
      properties: {
        Name: `${props.stackPrefix}-KnowledgeBase-${stableSuffix}`,
        RoleArn: knowledgeBaseRole.roleArn,
        EmbeddingModelArn: embeddingModelArn,
        CollectionArn: this.vectorCollection.attrArn,
        VectorIndexName: VECTOR_INDEX_NAME,
        VectorField: VECTOR_FIELD_NAME,
        TextField: TEXT_FIELD_NAME,
        MetadataField: METADATA_FIELD_NAME,
        Description: "Knowledge base for RAG application with S3 and web-crawled content",
        S3BucketArn: this.knowledgeBaseBucket.bucketArn,
        WebCrawlerUrls: webCrawlerUrls
      },
    });

    // Important: Wait for vector index to exist before creating Knowledge Base
    kbCustomResource.node.addDependency(vectorIndexCustomResource);

    this.knowledgeBaseId = kbCustomResource.getAttString("KnowledgeBaseId");
    this.s3DataSourceId = kbCustomResource.getAttString("S3DataSourceId");
    this.webCrawlerDataSourceId = kbCustomResource.getAttString("WebCrawlerDataSourceId");

    // Store Knowledge Base ID in AWS Secrets Manager
    const knowledgeBaseIdSecret = new secretsmanager.Secret(this, "KnowledgeBaseIdSecret", {
      // TODO: CHANGE THIS SECRET TO /KnowledgeBase/Id IN PRODUCTION
      secretName: `${props.stackPrefix}/KnowledgeBase/IdV2`,
      description: "The ID of the Bedrock Knowledge Base",
      secretStringValue: cdk.SecretValue.unsafePlainText(this.knowledgeBaseId),
    });

    // Outputs
    new CfnOutput(this, "KnowledgeBaseId", {
      value: this.knowledgeBaseId,
      description: "The ID of the Bedrock Knowledge Base",
    });

    new CfnOutput(this, "KnowledgeBaseBucketName", {
      value: this.knowledgeBaseBucket.bucketName,
      description: "The name of the S3 bucket for knowledge base documents",
    });

    new CfnOutput(this, "KnowledgeBaseBucketArn", {
      value: this.knowledgeBaseBucket.bucketArn,
      description: "The ARN of the S3 bucket for knowledge base documents",
    });

    new CfnOutput(this, "S3DataSourceId", {
      value: this.s3DataSourceId,
      description: "The ID of the S3 data source",
    });

    new CfnOutput(this, "WebCrawlerDataSourceId", {
      value: this.webCrawlerDataSourceId,
      description: "The ID of the Web Crawler data source",
    });

    new CfnOutput(this, "VectorCollectionArn", {
      value: this.vectorCollection.attrArn,
      description: "The ARN of the OpenSearch Serverless collection",
    });

    new CfnOutput(this, "KnowledgeBaseIdSecretArn", {
      value: knowledgeBaseIdSecret.secretArn,
      description: "The ARN of the secret containing the Knowledge Base ID",
    });
  }
}

