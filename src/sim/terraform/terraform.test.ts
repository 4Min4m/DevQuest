import { describe, expect, it } from 'vitest';
import { makeShell } from '../testing';
import { createAwsState, DEFAULT_KEY } from '../aws/api';
import { evaluate } from './eval';
import { functions } from './functions';
import { parseHcl } from './hcl';
import { formatHcl } from './fmt';

function lab(files: Record<string, string>) {
  const t = makeShell();
  t.state.aws = createAwsState();
  t.setup(`aws configure set aws_access_key_id ${DEFAULT_KEY.id}`, `aws configure set aws_secret_access_key ${DEFAULT_KEY.secret}`, 'aws configure set region us-east-1', 'mkdir -p ~/tf');
  const v = t.vfs();
  for (const [p, c] of Object.entries(files)) {
    const full = `/home/student/tf/${p}`;
    v.mkdir(full.replace(/\/[^/]*$/, ''), { parents: true });
    v.writeFile(full, c);
  }
  t.state.cwd = '/home/student/tf';
  return t;
}

const ev = (src: string, vars: Record<string, unknown> = {}) => {
  const body = parseHcl(`x = ${src}\n`, 't.tf');
  return evaluate(body.attrs[0].expr, { root: (n) => vars[n], fn: functions(() => null, () => '') });
};

describe('hcl', () => {
  it('parses expressions', () => {
    expect(ev('"web-${n + 1}"', { n: 1 })).toBe('web-2');
    expect(ev('[for s in ["a", "b"] : upper(s)]')).toEqual(['A', 'B']);
    expect(ev('{ for k, v in m : v => k }', { m: { a: 'x' } })).toEqual({ x: 'a' });
    expect(ev('n > 1 ? "many" : "one"', { n: 2 })).toBe('many');
    expect(ev('cidrsubnet("10.0.0.0/16", 8, 2)')).toBe('10.0.2.0/24');
    expect(ev('l[*].id', { l: [{ id: 1 }, { id: 2 }] })).toEqual([1, 2]);
    expect(ev('format("%s-%03d", "web", 7)')).toBe('web-007');
    expect(ev('merge({a = 1}, {b = 2})')).toEqual({ a: 1, b: 2 });
    expect(ev('try(m.nope, "fallback")', { m: {} })).toBe('fallback');
    expect(ev('<<-EOT\n    hello ${name}\n    EOT\n', { name: 'x' })).toBe('hello x\n');
  });
  it('reports syntax errors with positions', () => {
    expect(() => parseHcl('resource "aws_s3_bucket" "b" {\n  bucket = \n}\n', 'main.tf')).toThrow('Invalid expression');
  });
  it('formats like terraform fmt', () => {
    expect(formatHcl('resource "x" "y" {\nami="a"\n    instance_type = "t3.micro"\ntags = {\nName="web"\n}\n}\n')).toBe('resource "x" "y" {\n  ami           = "a"\n  instance_type = "t3.micro"\n  tags = {\n    Name = "web"\n  }\n}\n');
  });
});

const BUCKET = `terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "us-east-1"
}

variable "name" {
  type    = string
  default = "dq-tf-site"
}

resource "aws_s3_bucket" "site" {
  bucket = var.name
  tags = {
    Owner = "devquest"
  }
}

resource "aws_s3_object" "index" {
  bucket       = aws_s3_bucket.site.id
  key          = "index.html"
  content      = "<h1>hello</h1>"
  content_type = "text/html"
}

output "bucket_arn" {
  value = aws_s3_bucket.site.arn
}
`;

describe('terraform workflow', () => {
  it('needs init first', () => {
    const t = lab({ 'main.tf': BUCKET });
    const r = t.run('terraform plan');
    expect(r.code).toBe(1);
    expect(r.err).toContain('Error: Inconsistent dependency lock file');
    const init = t.run('terraform init');
    expect(init.code).toBe(0);
    expect(init.out).toContain('- Installing hashicorp/aws v5.72.1...');
    expect(init.out).toContain('Terraform has been successfully initialized!');
    expect(t.read('/home/student/tf/.terraform.lock.hcl')).toContain('provider "registry.terraform.io/hashicorp/aws"');
  });
  it('plans, applies, is idempotent and destroys', () => {
    const t = lab({ 'main.tf': BUCKET });
    t.setup('terraform init');
    const plan = t.run('terraform plan');
    expect(plan.err).toBe('');
    expect(plan.out).toContain('  # aws_s3_bucket.site will be created\n  + resource "aws_s3_bucket" "site" {\n      + arn                         = "arn:aws:s3:::dq-tf-site"');
    expect(plan.out).toContain('      + bucket                      = "dq-tf-site"');
    expect(plan.out).toContain('Plan: 2 to add, 0 to change, 0 to destroy.');
    expect(plan.out).toContain('  + bucket_arn = "arn:aws:s3:::dq-tf-site"');
    const cancelled = t.run('terraform apply');
    expect(cancelled.out).toContain('Apply cancelled.');
    const apply = t.run('echo yes | terraform apply');
    expect(apply.err).toBe('');
    expect(apply.out).toContain('aws_s3_bucket.site: Creating...\naws_s3_bucket.site: Creation complete after 1s [id=dq-tf-site]\naws_s3_object.index: Creating...');
    expect(apply.out).toContain('Apply complete! Resources: 2 added, 0 changed, 0 destroyed.\n\nOutputs:\n\nbucket_arn = "arn:aws:s3:::dq-tf-site"');
    expect(t.run('aws s3 ls s3://dq-tf-site').out).toContain('index.html');
    expect(t.run('terraform plan').out).toContain('No changes. Your infrastructure matches the configuration.');
    expect(t.run('terraform state list').out).toBe('aws_s3_bucket.site\naws_s3_object.index\n');
    expect(t.run('terraform output -raw bucket_arn').out).toBe('arn:aws:s3:::dq-tf-site');
    expect(JSON.parse(t.read('/home/student/tf/terraform.tfstate')).serial).toBe(1);
    const d = t.run('terraform destroy -auto-approve');
    expect(d.out).toContain('aws_s3_object.index: Destroying... [id=index.html]');
    expect(d.out.indexOf('aws_s3_object.index: Destroying')).toBeLessThan(d.out.indexOf('aws_s3_bucket.site: Destroying'));
    expect(d.out).toContain('Destroy complete! Resources: 2 destroyed.');
    expect(t.state.aws!.buckets['dq-tf-site']).toBeUndefined();
  });
  it('updates in place, forces replacement, and detects drift', () => {
    const t = lab({ 'main.tf': BUCKET });
    t.setup('terraform init', 'terraform apply -auto-approve');
    t.setup("sed -i 's/Owner = \"devquest\"/Owner = \"platform\"/' main.tf");
    const up = t.run('terraform plan');
    expect(up.out).toContain('  # aws_s3_bucket.site will be updated in-place\n  ~ resource "aws_s3_bucket" "site" {');
    expect(up.out).toContain('          ~ "Owner" = "devquest" -> "platform"');
    expect(up.out).toContain('Plan: 0 to add, 2 to change, 0 to destroy.'.replace('2', '1'));
    const rep = t.run('terraform plan -var name=dq-tf-other');
    expect(rep.out).toContain('  # aws_s3_bucket.site must be replaced\n-/+ resource "aws_s3_bucket" "site" {');
    expect(rep.out).toContain('      ~ bucket                      = "dq-tf-site" -> "dq-tf-other" # forces replacement');
    // Someone deletes the object by hand.
    t.setup('aws s3 rm s3://dq-tf-site/index.html');
    const drift = t.run('terraform plan');
    expect(drift.out).toContain('Note: Objects have changed outside of Terraform');
    expect(drift.out).toContain('  # aws_s3_object.index has been deleted');
    expect(drift.out).toContain('  # aws_s3_object.index will be created');
  });
  it('real errors: undeclared references, unknown arguments, missing variables, AWS errors', () => {
    const t = lab({ 'main.tf': 'resource "aws_s3_bucket" "b" {\n  bucket = var.bucket_name\n  name   = "x"\n}\n' });
    t.setup('terraform init');
    let r = t.run('terraform plan');
    expect(r.err).toContain('│ Error: Reference to undeclared input variable\n│ \n│   on main.tf line 2, in resource "aws_s3_bucket" "b":\n│    2:   bucket = var.bucket_name\n│ \n│ An input variable with the name "bucket_name" has not been declared.');
    t.vfs().writeFile('/home/student/tf/main.tf', 'variable "bucket_name" {}\n\nresource "aws_s3_bucket" "b" {\n  bucket = var.bucket_name\n  name   = "x"\n}\n');
    r = t.run('terraform plan');
    expect(r.err).toContain('Error: No value for required variable');
    r = t.run('terraform plan -var bucket_name=test');
    expect(r.err).toContain('│ Error: Unsupported argument\n│ \n│   on main.tf line 5, in resource "aws_s3_bucket" "b":\n│    5:   name   = "x"\n│ \n│ An argument named "name" is not expected here.');
    t.setup("sed -i '/name   = \"x\"/d' main.tf");
    r = t.run('terraform apply -auto-approve -var bucket_name=test');
    expect(r.code).toBe(1);
    expect(r.err).toContain('Error: creating S3 Bucket (test): operation error S3: CreateBucket, https response error StatusCode: 409');
    expect(r.err).toContain('BucketAlreadyExists');
    expect(r.err).toContain('│   with aws_s3_bucket.b,\n│   on main.tf line 3, in resource "aws_s3_bucket" "b":');
  });
  it('count, for_each, locals, modules and a network you can reach', () => {
    const t = lab({
      'main.tf': `provider "aws" {
  region = "us-east-1"
}

locals {
  azs = ["us-east-1a", "us-east-1b"]
}

module "network" {
  source = "./modules/network"
  cidr   = "10.20.0.0/16"
  azs    = local.azs
}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }
}

resource "aws_security_group" "web" {
  name   = "web"
  vpc_id = module.network.vpc_id
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "web" {
  count                  = 2
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = "t3.micro"
  subnet_id              = module.network.subnet_ids[count.index]
  vpc_security_group_ids = [aws_security_group.web.id]
  user_data              = file("\${path.module}/init.sh")
  tags = {
    Name = "web-\${count.index}"
  }
}

output "ips" {
  value = aws_instance.web[*].public_ip
}
`,
      'init.sh': '#!/bin/bash\napt-get update\napt-get install -y nginx\n',
      'modules/network/main.tf': `variable "cidr" {
  type = string
}

variable "azs" {
  type = list(string)
}

resource "aws_vpc" "this" {
  cidr_block = var.cidr
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
}

resource "aws_subnet" "public" {
  for_each                = toset(var.azs)
  vpc_id                  = aws_vpc.this.id
  cidr_block              = cidrsubnet(var.cidr, 8, index(var.azs, each.key))
  availability_zone       = each.key
  map_public_ip_on_launch = true
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
}

resource "aws_route_table_association" "public" {
  for_each       = aws_subnet.public
  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

output "vpc_id" {
  value = aws_vpc.this.id
}

output "subnet_ids" {
  value = [for az in var.azs : aws_subnet.public[az].id]
}
`,
    });
    expect(t.run('terraform init').out).toContain('Initializing modules...\n- network in modules/network');
    const plan = t.run('terraform plan');
    expect(plan.err).toBe('');
    expect(plan.out).toContain('data.aws_ami.ubuntu: Read complete after 0s [id=ami-04b70fa74e45c3917]');
    expect(plan.out).toContain('  # module.network.aws_subnet.public["us-east-1a"] will be created');
    expect(plan.out).toContain('  # aws_instance.web[1] will be created');
    expect(plan.out).toContain('Plan: 10 to add, 0 to change, 0 to destroy.');
    const apply = t.run('terraform apply -auto-approve');
    expect(apply.err).toBe('');
    expect(apply.out).toContain('aws_instance.web[0]: Still creating... [10s elapsed]');
    const ips = JSON.parse(t.run('terraform output -json ips').out) as string[];
    expect(ips).toHaveLength(2);
    expect(t.run(`curl -s http://${ips[1]}`).out).toContain('Welcome to nginx!');
    expect(t.run('terraform plan').out).toContain('No changes.');
    // Scale down: count 2 → 1 destroys web[1].
    t.setup("sed -i 's/count                  = 2/count                  = 1/' main.tf");
    expect(t.run('terraform plan').out).toContain('  # aws_instance.web[1] will be destroyed\n  # (because index [1] is out of range for count)');
  });
  it('for_each needs a set or map', () => {
    const t = lab({ 'main.tf': 'resource "random_pet" "p" {\n  for_each = ["a", "b"]\n  prefix   = each.key\n}\n' });
    t.setup('terraform init');
    const r = t.run('terraform plan');
    expect(r.err).toContain('Error: Invalid for_each argument');
    expect(r.err).toContain('the "for_each" argument must be a map, or set of strings, and you have provided a value of type tuple.');
  });
  it('state locks block concurrent runs until force-unlock', () => {
    const t = lab({ 'main.tf': 'resource "random_id" "x" {\n  byte_length = 4\n}\n' });
    t.setup('terraform init', 'terraform apply -auto-approve');
    t.vfs().writeFile('/home/student/tf/.terraform.tfstate.lock.info', JSON.stringify({ ID: '5d1c6e2a-7f3b-4c8d-9e0f-1a2b3c4d5e6f', Operation: 'OperationTypeApply', Info: '', Who: 'ci@runner-7', Version: '1.9.8', Created: '2026-11-06T08:51:12Z', Path: 'terraform.tfstate' }));
    const r = t.run('terraform plan');
    expect(r.err).toContain('Error: Error acquiring the state lock');
    expect(r.err).toContain('ID:        5d1c6e2a-7f3b-4c8d-9e0f-1a2b3c4d5e6f');
    expect(t.run('terraform force-unlock -force 5d1c6e2a-7f3b-4c8d-9e0f-1a2b3c4d5e6f').out).toContain('Terraform state has been successfully unlocked!');
    expect(t.run('terraform plan').out).toContain('No changes.');
  });
  it('import, state rm/mv, fmt -check, validate, local_file', () => {
    const t = lab({ 'main.tf': 'resource "aws_s3_bucket" "logs" {\n  bucket = "dq-old-logs"\n}\n\nresource "local_file" "note" {\n  filename = "${path.module}/note.txt"\n  content  = "hi"\n}\n' });
    t.setup('aws s3 mb s3://dq-old-logs', 'terraform init');
    const imp = t.run('terraform import aws_s3_bucket.logs dq-old-logs');
    expect(imp.out).toContain('Import successful!');
    const plan = t.run('terraform plan');
    expect(plan.out).toContain('Plan: 1 to add, 0 to change, 0 to destroy.');
    t.setup('terraform apply -auto-approve');
    expect(t.read('/home/student/tf/note.txt')).toBe('hi');
    expect(t.run('terraform state mv aws_s3_bucket.logs aws_s3_bucket.archive').out).toContain('Successfully moved 1 object(s).');
    expect(t.run('terraform state rm local_file.note').out).toContain('Removed local_file.note');
    t.vfs().writeFile('/home/student/tf/extra.tf', 'output "x" {\nvalue="1"\n}\n');
    const f = t.run('terraform fmt -check');
    expect(f.code).toBe(3);
    expect(f.out).toBe('extra.tf\n');
    expect(t.run('terraform fmt').out).toBe('extra.tf\n');
    expect(t.run('terraform validate').out).toContain('Success! The configuration is valid.');
  });
  it('remote state in S3', () => {
    const t = lab({ 'main.tf': 'terraform {\n  backend "s3" {\n    bucket       = "dq-tfstate"\n    key          = "prod/terraform.tfstate"\n    region       = "us-east-1"\n    use_lockfile = true\n  }\n}\n\nresource "random_pet" "name" {}\n' });
    expect(t.run('terraform init').err).toContain('S3 bucket "dq-tfstate" does not exist');
    t.setup('aws s3 mb s3://dq-tfstate', 'terraform init', 'terraform apply -auto-approve');
    expect(t.state.aws!.buckets['dq-tfstate'].objects['prod/terraform.tfstate'].body).toContain('"random_pet"');
    expect(t.vfs().exists('/home/student/tf/terraform.tfstate')).toBe(false);
  });
});
