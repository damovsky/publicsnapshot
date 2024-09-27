import boto3
import os
from datetime import datetime, timedelta
import json
import logging
from aws_xray_sdk.core import xray_recorder
from aws_xray_sdk.core import patch_all
from datetime import datetime
from datetime import datetime

# Patch all supported libraries for X-Ray
patch_all()

# Set up logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

central_region = 'eu-central-1'


@xray_recorder.capture('handler')
def handler(event, context):
    region = event.get('region', central_region)  
    # rds = get_boto3_client('rds')

    # purgeTable()
    logger.info("Starting snapshot collection process")
    cutoff_time = datetime.utcnow() - timedelta(hours=3)
    cutoff_time = cutoff_time.replace(tzinfo=None)
    logger.info(f"Collecting snapshots created after: {cutoff_time.isoformat()}")
    
    ec2_count = fetch_ec2_snapshots(cutoff_time, region)
    # rds_count = fetch_rds_snapshots(cutoff_time)
    # rds_cluster_count = fetch_rds_cluster_snapshots(cutoff_time)

    # total_count = ec2_count + rds_count + rds_cluster_count
    # logger.info(f"Total new snapshots found: {total_count}")

def get_boto3_client(service_name, region):
    if not hasattr(get_boto3_client, 'sessions'):
        get_boto3_client.sessions = {}
    if region not in get_boto3_client.sessions:
        get_boto3_client.sessions[region] = boto3.Session(region_name=region)
    return get_boto3_client.sessions[region].client(service_name)

def get_boto3_resource(resource_name, region):
    if not hasattr(get_boto3_resource, 'sessions'):
        get_boto3_resource.sessions = {}
    if region not in get_boto3_resource.sessions:
        get_boto3_resource.sessions[region] = boto3.Session(region_name=region)
    return get_boto3_resource.sessions[region].resource(resource_name)




@xray_recorder.capture('fetch_ec2_snapshots')
def fetch_ec2_snapshots(cutoff_time, region):
    logger.info("Fetching EC2 snapshots")
    
    paginator = get_boto3_client('ec2', region).get_paginator('describe_snapshots')
    # paginate over all publicly available snaphosts

    filter=[
            {
                'Name': 'start-time',
                'Values': [
                    datetime(2024, 9, 4).date().isoformat(),
                ]
            },
        ]

    count = 0
    marker = None
    while True:
        response_iterator = paginator.paginate(RestorableByUserIds=['all'], PaginationConfig={'PageSize': 1000, 'StartingToken': marker})

        for page in response_iterator:
            for snapshot in page['Snapshots']:
                snapshot_start_time = snapshot['StartTime']
                snapshot_start_time = snapshot_start_time.replace(tzinfo=None)
                
               # Convert snapshot_start_time to a timezone-aware datetime object 
                if snapshot_start_time > cutoff_time:
                    store_snapshot(snapshot, 'EC2', region)
                    count += 1
        # logger.info(f"Found {count} new EC2 snapshots")
        try:
            marker = response_iterator['Marker']
            print(marker)
        except TypeError:
            break
    return count



@xray_recorder.capture('fetch_rds_snapshots')
def fetch_rds_snapshots(cutoff_time):
    logger.info("Fetching RDS snapshots")
    paginator = rds.get_paginator('describe_db_snapshots')
    count = 0
    for page in paginator.paginate(SnapshotType='public'):
        for snapshot in page['DBSnapshots']:
            if snapshot['SnapshotCreateTime'] > cutoff_time:
                store_snapshot(snapshot, 'RDS')
                count += 1
    logger.info(f"Found {count} new RDS snapshots")
    return count

@xray_recorder.capture('fetch_rds_cluster_snapshots')
def fetch_rds_cluster_snapshots(cutoff_time):
    logger.info("Fetching RDS Cluster snapshots")
    paginator = rds.get_paginator('describe_db_cluster_snapshots')
    count = 0
    for page in paginator.paginate(SnapshotType='public'):
        for snapshot in page['DBClusterSnapshots']:
            if snapshot['SnapshotCreateTime'] > cutoff_time:
                store_snapshot(snapshot, 'RDSCluster')
                count += 1
    logger.info(f"Found {count} new RDS Cluster snapshots")
    return count

@xray_recorder.capture('store_snapshot')
def store_snapshot(snapshot, snapshot_type, region):
    try:
        item = {
            'snapshotId': snapshot['SnapshotId'],
            'snapshotType': snapshot_type,
            'startTime': snapshot['StartTime'].isoformat() if snapshot_type == 'EC2' else snapshot['SnapshotCreateTime'].isoformat(),
            'volumeSize': snapshot.get('VolumeSize', 0),
            'description': snapshot.get('Description', ''),
            'tags': json.dumps(snapshot.get('Tags', [])),
            'encrypted': snapshot['Encrypted'],
            'awsRegion': region,
            'ownerId': snapshot['OwnerId'],
            'ownerAlias': snapshot.get('OwnerAlias', '')
        }
        # Remove any keys with empty string values
        item = {k: v for k, v in item.items() if v != ''}

        dynamodb = get_boto3_resource('dynamodb', central_region)
        table = dynamodb.Table(os.environ['TABLE_NAME'])
        table.put_item(Item=item,
                       ConditionExpression='attribute_not_exists(snapshotId)'
                       )
        
    except Exception as e:
        logger.error(f"Error storing {snapshot_type} snapshot {snapshot['SnapshotId']}: {str(e)}")


# def purgeTable():
#     # Specify the name of the DynamoDB table
#     table_name = 'PublicSnapshotsTable'

#     # Get the Table resource
#     table = dynamodb.Table(table_name)

#     # Scan the table to get all items
#     response = table.scan()
#     items = response.get('Items', [])

#     # Delete all items from the table
#     with table.batch_writer() as batch:
#         for item in items:
#             batch.delete_item(Key={'snapshotId': item['snapshotId']})
