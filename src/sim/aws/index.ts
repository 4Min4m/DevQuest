/** Mock AWS: the aws CLI, public S3 endpoints, and EC2 networking rules for instances. */
import { registerHttpProvider } from '../net';
import type { HttpResult } from '../net';
import { registerMachineGate } from '../machines';
import { publicRead, WORKSTATION_PUBLIC_IP } from './api';
import { internetPath } from './shapes';

export { awsCommand } from './cli';
export { createAwsState } from './api';
export * as awsApi from './api';

const xmlError = (code: string, msg: string, extra = '') =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${msg}</Message>${extra}<RequestId>8F2A3B4C5D6E7F80</RequestId><HostId>devquest</HostId></Error>`;

// EC2 instances are reachable only through an internet gateway route and an open security group.
registerMachineGate((state, m, port, via) => {
  const id = m.machine?.ec2;
  if (!id || !state.aws) return null;
  const inst = state.aws.instances.find((i) => i.id === id);
  if (!inst) return 'timeout';
  if (via === 'private') return 'timeout';
  return internetPath(state.aws, inst, port, WORKSTATION_PUBLIC_IP) ? 'timeout' : null;
});

registerHttpProvider((state, req): HttpResult | undefined => {
  if (state.context) return undefined;
  // "What is my public IP?" services (for /32 security-group rules).
  if (['checkip.amazonaws.com', 'ifconfig.me', 'api.ipify.org', 'icanhazip.com'].includes(req.host)) {
    return { kind: 'response', res: { status: 200, body: WORKSTATION_PUBLIC_IP + '\n', headers: { 'Content-Type': 'text/plain' } } };
  }
  if (!state.aws) return undefined;
  // https://BUCKET.s3.amazonaws.com/KEY, https://BUCKET.s3.REGION.amazonaws.com/KEY, http://BUCKET.s3-website-REGION.amazonaws.com/
  const m = /^([a-z0-9.-]+)\.s3(?:[.-](website)?-?([a-z0-9-]+))?\.amazonaws\.com$/.exec(req.host);
  if (!m) return undefined;
  const [, name, website, region] = m;
  const b = state.aws.buckets[name];
  const key = decodeURIComponent(req.path.replace(/^\//, ''));
  const headers = { 'Content-Type': 'application/xml', Server: 'AmazonS3' };
  if (website) {
    if (!b) return { kind: 'response', res: { status: 404, body: `<html>\n<head><title>404 Not Found</title></head>\n<body>\n<h1>404 Not Found</h1>\n<ul>\n<li>Code: NoSuchBucket</li>\n<li>Message: The specified bucket does not exist</li>\n<li>BucketName: ${name}</li>\n</ul>\n</body>\n</html>\n`, headers: { 'Content-Type': 'text/html', Server: 'AmazonS3' } } };
    if (!b.website || (region && region !== b.region)) return { kind: 'response', res: { status: 404, body: `<html>\n<head><title>404 Not Found</title></head>\n<body>\n<h1>404 Not Found</h1>\n<ul>\n<li>Code: NoSuchWebsiteConfiguration</li>\n<li>Message: The specified bucket does not have a website configuration</li>\n<li>BucketName: ${name}</li>\n</ul>\n</body>\n</html>\n`, headers: { 'Content-Type': 'text/html', Server: 'AmazonS3' } } };
    if (!publicRead(b)) return { kind: 'response', res: { status: 403, body: `<html>\n<head><title>403 Forbidden</title></head>\n<body>\n<h1>403 Forbidden</h1>\n<ul>\n<li>Code: AccessDenied</li>\n<li>Message: Access Denied</li>\n</ul>\n</body>\n</html>\n`, headers: { 'Content-Type': 'text/html', Server: 'AmazonS3' } } };
    const k = !key || key.endsWith('/') ? key + b.website.index : key;
    const o = b.objects[k] ?? b.objects[k + '/' + b.website.index];
    if (o) return { kind: 'response', res: { status: 200, body: o.body, headers: { 'Content-Type': o.contentType ?? 'text/html', Server: 'AmazonS3', ETag: `"${o.etag}"` } } };
    const err = b.website.error ? b.objects[b.website.error] : undefined;
    if (err) return { kind: 'response', res: { status: 404, body: err.body, headers: { 'Content-Type': 'text/html', Server: 'AmazonS3' } } };
    return { kind: 'response', res: { status: 404, body: `<html>\n<head><title>404 Not Found</title></head>\n<body>\n<h1>404 Not Found</h1>\n<ul>\n<li>Code: NoSuchKey</li>\n<li>Message: The specified key does not exist.</li>\n<li>Key: ${k}</li>\n</ul>\n</body>\n</html>\n`, headers: { 'Content-Type': 'text/html', Server: 'AmazonS3' } } };
  }
  if (!b) return { kind: 'response', res: { status: 404, body: xmlError('NoSuchBucket', 'The specified bucket does not exist', `<BucketName>${name}</BucketName>`), headers } };
  if (!publicRead(b)) return { kind: 'response', res: { status: 403, body: xmlError('AccessDenied', 'Access Denied'), headers } };
  const o = b.objects[key];
  if (!o) return { kind: 'response', res: { status: 404, body: xmlError('NoSuchKey', 'The specified key does not exist.', `<Key>${key}</Key>`), headers } };
  return { kind: 'response', res: { status: 200, body: o.body, headers: { 'Content-Type': o.contentType ?? 'binary/octet-stream', Server: 'AmazonS3', ETag: `"${o.etag}"` } } };
}, 4);
