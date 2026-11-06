import { describe, expect, it } from 'vitest';
import { makeShell } from '../testing';
import { createAwsState, DEFAULT_KEY } from './api';
import { jmes } from './jmes';

function cloud(configured = true) {
  const t = makeShell();
  t.state.aws = createAwsState();
  if (configured) {
    t.setup(`aws configure set aws_access_key_id ${DEFAULT_KEY.id}`, `aws configure set aws_secret_access_key ${DEFAULT_KEY.secret}`, 'aws configure set region us-east-1');
  }
  return t;
}

describe('jmespath subset', () => {
  const data = { Reservations: [{ Instances: [{ InstanceId: 'i-1', State: { Name: 'running' }, Tags: [{ Key: 'Name', Value: 'web' }] }, { InstanceId: 'i-2', State: { Name: 'stopped' } }] }] };
  it('projections, filters, multiselect', () => {
    expect(jmes('Reservations[].Instances[].InstanceId', data)).toEqual(['i-1', 'i-2']);
    expect(jmes("Reservations[].Instances[?State.Name=='running'].InstanceId", data)).toEqual([['i-1']]);
    expect(jmes("Reservations[].Instances[?State.Name=='running'][].InstanceId", data)).toEqual(['i-1']);
    expect(jmes('Reservations[0].Instances[0].{id:InstanceId,state:State.Name}', data)).toEqual({ id: 'i-1', state: 'running' });
    expect(jmes('Reservations[].Instances[].[InstanceId,State.Name]', data)).toEqual([['i-1', 'running'], ['i-2', 'stopped']]);
    expect(jmes("Reservations[].Instances[].Tags[?Key=='Name'].Value | []", data)).toEqual(['web']);
    expect(jmes('length(Reservations[].Instances[])', data)).toBe(2);
  });
});

describe('aws credentials', () => {
  it('missing credentials and region', () => {
    const t = cloud(false);
    const r = t.run('aws sts get-caller-identity');
    expect(r.code).toBe(253);
    expect(r.err).toContain('Unable to locate credentials. You can configure credentials by running "aws configure".');
    t.setup(`aws configure set aws_access_key_id ${DEFAULT_KEY.id}`, `aws configure set aws_secret_access_key ${DEFAULT_KEY.secret}`);
    expect(t.run('aws ec2 describe-vpcs').err).toContain('You must specify a region.');
    expect(JSON.parse(t.run('aws sts get-caller-identity').out).Arn).toBe('arn:aws:iam::123456789012:user/student');
  });
  it('bad keys and env vars', () => {
    const t = cloud();
    const r = t.run('AWS_ACCESS_KEY_ID=AKIAXXXXXXXXXXXXXXXX AWS_SECRET_ACCESS_KEY=x aws sts get-caller-identity');
    expect(r.code).toBe(254);
    expect(r.err).toContain('An error occurred (InvalidClientTokenId) when calling the GetCallerIdentity operation: The security token included in the request is invalid.');
    expect(t.run(`AWS_ACCESS_KEY_ID=${DEFAULT_KEY.id} AWS_SECRET_ACCESS_KEY=wrong aws s3 ls`).err).toContain('SignatureDoesNotMatch');
    expect(t.run('aws --profile prod s3 ls').err).toContain('The config profile (prod) could not be found');
    expect(t.run('aws configure list').out).toContain('****************MPLE');
  });
});

describe('aws s3', () => {
  it('buckets, objects and listing', () => {
    const t = cloud();
    expect(t.run('aws s3 mb s3://dq-site-4821').out).toBe('make_bucket: dq-site-4821\n');
    const taken = t.run('aws s3 mb s3://test');
    expect(taken.code).toBe(1);
    expect(taken.err).toContain('make_bucket failed: s3://test An error occurred (BucketAlreadyExists)');
    t.setup('mkdir site', 'echo "<h1>Hi</h1>" > site/index.html', 'echo err > site/404.html');
    expect(t.run('aws s3 sync site s3://dq-site-4821').out).toBe('upload: site/404.html to s3://dq-site-4821/404.html\nupload: site/index.html to s3://dq-site-4821/index.html\n');
    expect(t.run('aws s3 sync site s3://dq-site-4821').out).toBe('');
    expect(t.run('aws s3 ls s3://dq-site-4821').out).toMatch(/\d{4}-\d\d-\d\d \d\d:\d\d:\d\d +12 index.html/);
    expect(t.run('aws s3 rb s3://dq-site-4821').err).toContain('BucketNotEmpty');
    expect(JSON.parse(t.run('aws s3api list-objects-v2 --bucket dq-site-4821 --query "Contents[].Key"').out)).toEqual(['404.html', 'index.html']);
  });
  it('a public static website needs website config, no public-access block and a policy', () => {
    const t = cloud();
    t.setup('aws s3 mb s3://dq-site', 'echo hello > index.html', 'aws s3 cp index.html s3://dq-site/');
    const url = 'http://dq-site.s3-website-us-east-1.amazonaws.com';
    expect(t.run(`curl -s ${url}`).out).toContain('NoSuchWebsiteConfiguration');
    t.setup('aws s3 website s3://dq-site --index-document index.html');
    expect(t.run(`curl -s ${url}`).out).toContain('403 Forbidden');
    const pol = '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":"*","Action":"s3:GetObject","Resource":"arn:aws:s3:::dq-site/*"}]}';
    t.vfs().writeFile('/home/student/policy.json', pol);
    const blocked = t.run('aws s3api put-bucket-policy --bucket dq-site --policy file://policy.json');
    expect(blocked.err).toContain('because public policies are blocked by the BlockPublicPolicy block public access setting');
    t.setup('aws s3api delete-public-access-block --bucket dq-site', 'aws s3api put-bucket-policy --bucket dq-site --policy file://policy.json');
    expect(t.run(`curl -s ${url}`).out).toBe('hello\n');
    expect(t.run('curl -s https://dq-site.s3.amazonaws.com/index.html').out).toBe('hello\n');
  });
});

describe('aws ec2', () => {
  it('launches an instance you can ssh into once the security group allows it', () => {
    const t = cloud();
    t.setup('aws ec2 create-key-pair --key-name dq --query KeyMaterial --output text > dq.pem', 'chmod 400 dq.pem');
    const sg = t.run('aws ec2 create-security-group --group-name web --description "web servers" --query GroupId --output text').out.trim();
    expect(sg).toMatch(/^sg-0[0-9a-f]{16}$/);
    t.vfs().writeFile('/home/student/user-data.sh', '#!/bin/bash\napt-get update\napt-get install -y nginx\n');
    const run = JSON.parse(t.run(`aws ec2 run-instances --image-id ami-04b70fa74e45c3917 --instance-type t3.micro --key-name dq --security-group-ids ${sg} --user-data file://user-data.sh --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=web}]'`).out);
    const inst = run.Instances[0];
    expect(inst.State.Name).toBe('pending');
    const ip = t.run("aws ec2 describe-instances --filters Name=tag:Name,Values=web --query 'Reservations[].Instances[].PublicIpAddress' --output text").out.trim();
    expect(ip).toMatch(/^54\./);
    expect(t.run(`aws ec2 describe-instances --instance-ids ${inst.InstanceId} --query 'Reservations[0].Instances[0].State.Name' --output text`).out).toBe('running\n');
    expect(t.run(`ssh -i dq.pem ubuntu@${ip} hostname`).err).toContain('Connection timed out');
    expect(t.run(`curl -s -m 5 http://${ip}`).code).toBe(28);
    t.setup(`aws ec2 authorize-security-group-ingress --group-id ${sg} --protocol tcp --port 22 --cidr 203.0.113.10/32`);
    expect(t.run(`ssh -i dq.pem ubuntu@${ip} hostname`).out).toMatch(/^ip-172-31-/);
    t.setup(`aws ec2 authorize-security-group-ingress --group-id ${sg} --protocol tcp --port 80 --cidr 0.0.0.0/0`);
    expect(t.run(`curl -s http://${ip}`).out).toContain('Welcome to nginx!');
    expect(t.run(`aws ec2 authorize-security-group-ingress --group-id ${sg} --protocol tcp --port 80 --cidr 0.0.0.0/0`).err).toContain('InvalidPermission.Duplicate');
    expect(t.run(`aws ec2 get-console-output --instance-id ${inst.InstanceId} --output text`).out).toContain('Setting up nginx');
  });
  it('custom VPC needs an internet gateway route', () => {
    const t = cloud();
    const vpc = t.run('aws ec2 create-vpc --cidr-block 10.0.0.0/16 --query Vpc.VpcId --output text').out.trim();
    const subnet = t.run(`aws ec2 create-subnet --vpc-id ${vpc} --cidr-block 10.0.1.0/24 --query Subnet.SubnetId --output text`).out.trim();
    expect(t.run(`aws ec2 create-subnet --vpc-id ${vpc} --cidr-block 10.1.0.0/24`).err).toContain('InvalidSubnet.Range');
    t.setup(`aws ec2 modify-subnet-attribute --subnet-id ${subnet} --map-public-ip-on-launch`);
    const sg = t.run(`aws ec2 create-security-group --group-name ssh --description ssh --vpc-id ${vpc} --query GroupId --output text`).out.trim();
    t.setup(`aws ec2 authorize-security-group-ingress --group-id ${sg} --protocol tcp --port 22 --cidr 0.0.0.0/0`, 'aws ec2 create-key-pair --key-name k --query KeyMaterial --output text > k.pem', 'chmod 600 k.pem');
    const ip = t.run(`aws ec2 run-instances --image-id ami-04b70fa74e45c3917 --instance-type t3.micro --key-name k --subnet-id ${subnet} --security-group-ids ${sg} --query 'Instances[0].PublicIpAddress' --output text`).out.trim();
    expect(t.run(`ssh -i k.pem ubuntu@${ip} true`).err).toContain('Connection timed out');
    const igw = t.run('aws ec2 create-internet-gateway --query InternetGateway.InternetGatewayId --output text').out.trim();
    t.setup(`aws ec2 attach-internet-gateway --internet-gateway-id ${igw} --vpc-id ${vpc}`);
    const rtb = t.run(`aws ec2 describe-route-tables --filters Name=vpc-id,Values=${vpc} --query 'RouteTables[0].RouteTableId' --output text`).out.trim();
    t.setup(`aws ec2 create-route --route-table-id ${rtb} --destination-cidr-block 0.0.0.0/0 --gateway-id ${igw}`);
    expect(t.run(`ssh -i k.pem ubuntu@${ip} hostname`).out).toMatch(/^ip-10-0-1-\d+\n$/);
  });
  it('cleanup: stopped instances lose their public IP, volumes and EIPs cost money', () => {
    const t = cloud();
    const id = t.run('aws ec2 run-instances --image-id ami-04b70fa74e45c3917 --instance-type t3.micro --query Instances[0].InstanceId --output text').out.trim();
    t.setup(`aws ec2 stop-instances --instance-ids ${id}`);
    expect(t.run(`aws ec2 describe-instances --instance-ids ${id} --query 'Reservations[0].Instances[0].[State.Name,PublicIpAddress]' --output text`).out).toBe('stopped\tNone\n');
    const vol = t.run('aws ec2 create-volume --size 100 --availability-zone us-east-1a --query VolumeId --output text').out.trim();
    expect(t.run('aws ec2 describe-volumes --filters Name=status,Values=available --query Volumes[].VolumeId --output text').out.trim()).toBe(vol);
    t.setup(`aws ec2 delete-volume --volume-id ${vol}`, `aws ec2 terminate-instances --instance-ids ${id}`);
    expect(t.run('aws ec2 describe-volumes --query "length(Volumes)"').out).toBe('0\n');
    expect(t.run('aws ec2 delete-volume --volume-id vol-0nope').err).toContain('InvalidVolume.NotFound');
    expect(t.run('aws ec2 run-instances --image-id ami-04b70fa74e45c3917 --instance-type t3.huge').err).toContain("Invalid value 't3.huge' for InstanceType.");
    expect(t.run('aws ec2 run-instances --image-id ami-04b70fa74e45c3917 --instance-type t3.micro --dry-run').err).toContain('DryRunOperation');
  });
  it('IAM denies what the user is not allowed to do', () => {
    const t = makeShell();
    t.state.aws = createAwsState({ users: { 'ci-bot': ['s3:*'] } });
    t.setup(`aws configure set aws_access_key_id ${DEFAULT_KEY.id}`, `aws configure set aws_secret_access_key ${DEFAULT_KEY.secret}`, 'aws configure set region us-east-1');
    expect(t.run('aws s3 mb s3://dq-ci-artifacts').code).toBe(0);
    expect(t.run('aws ec2 describe-instances').err).toContain('An error occurred (UnauthorizedOperation) when calling the DescribeInstances operation: You are not authorized to perform this operation. User: arn:aws:iam::123456789012:user/ci-bot');
  });
});
