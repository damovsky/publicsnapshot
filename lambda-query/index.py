import json
import boto3
import os
from boto3.dynamodb.conditions import Key
import traceback
from decimal import Decimal

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(os.environ['TABLE_NAME'])

# Custom JSON encoder to handle Decimal
class DecimalEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super(DecimalEncoder, self).default(obj)

def lambda_handler(event, context):
    print("Received event:", json.dumps(event))
    
    try:
        query_params = event.get('queryStringParameters', {})
        
        if not query_params or 'snapshotType' not in query_params:
            response = table.scan()
        else:
            snapshot_type = query_params['snapshotType']
            if snapshot_type:
                response = table.scan(
                    FilterExpression=Key('snapshotType').eq(snapshot_type)
                )
            else:
                response = table.scan()
        
        # Use the custom encoder when logging the response
        print("DynamoDB response:", json.dumps(response, cls=DecimalEncoder))
        
        return {
            'statusCode': 200,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
                'Access-Control-Allow-Methods': 'GET,OPTIONS',
                'Content-Type': 'application/json'
            },
            'body': json.dumps(response.get('Items', []), cls=DecimalEncoder)
        }
    except Exception as e:
        print("Error:", str(e))
        print("Traceback:", traceback.format_exc())
        return {
            'statusCode': 500,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            'body': json.dumps({
                'error': str(e),
                'trace': traceback.format_exc()
            })
        }