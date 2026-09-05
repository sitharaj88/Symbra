import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFile } from '../../src/index/extract.js';
import { registerLanguage } from '../../src/languages/registry.js';
import { terraform, hcl } from '../../src/languages/terraform.js';

const src = readFileSync(new URL('../fixtures/terraform/main.tf', import.meta.url), 'utf8');
const packer = readFileSync(new URL('../fixtures/terraform/packer.hcl', import.meta.url), 'utf8');

beforeAll(() => {
  registerLanguage(terraform);
  registerLanguage(hcl);
});

describe('terraform extractor', () => {
  it('indexes every block kind with its terraform address as the name', async () => {
    const ir = (await extractFile('infra/main.tf', src))!;
    expect(ir.language).toBe('terraform');
    expect(ir.doc).toBe('Storage stack for the service.\nManaged by platform team.');
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));

    expect(by['aws_s3_bucket.artifacts'].kind).toBe('struct');
    expect(by['aws_s3_bucket.artifacts'].doc).toBe('Where every artifact lands.');
    expect(by['aws_s3_bucket.artifacts'].meta).toMatchObject({ block: 'resource', type: 'aws_s3_bucket', resource: 'artifacts' });
    expect(by['data.aws_iam_policy_document.readonly'].kind).toBe('struct');
    expect(by['module.vpc'].kind).toBe('namespace');
    expect(by['module.vpc'].meta).toMatchObject({ source: './modules/vpc' });
    expect(by['var.env'].kind).toBe('variable');
    expect(by['var.env'].declaredType).toBe('string');
    expect(by['var.env'].doc).toBe('Deployment environment.');
    expect(by['var.region'].meta).toMatchObject({ required: true });
    expect(by['bucket'].kind).toBe('constant');
    expect(by['bucket'].doc).toBe('The public bucket name.');
    expect(by['local.common_tags'].kind).toBe('constant');
    expect(by['local.bucket_arn'].kind).toBe('constant');
    expect(by['provider.aws'].kind).toBe('namespace');
    expect(by['terraform'].kind).toBe('namespace');
    expect(by['terraform.required_providers.aws'].meta).toMatchObject({ source: 'hashicorp/aws', version: '5.31.0' });
    expect(by['aws_s3_bucket.artifacts'].range.startLine).toBe(18);
  });

  it('turns traversals into references addressed like the blocks they point at', async () => {
    const ir = (await extractFile('infra/main.tf', src))!;
    const ord = (fqn: string) => ir.definitions.find((d) => d.fqn === fqn)!.ordinal;
    const has = (name: string, scopeFqn: string) =>
      ir.references.some((r) => r.kind === 'value' && r.name === name && r.scope === ord(scopeFqn));

    expect(has('var.region', 'provider.aws')).toBe(true);
    expect(has('var.env', 'aws_s3_bucket.artifacts')).toBe(true);
    expect(has('local.common_tags', 'aws_s3_bucket.artifacts')).toBe(true);
    // `depends_on = [aws_s3_bucket.artifacts]` and the `.id` traversal both land on the resource.
    expect(has('aws_s3_bucket.artifacts', 'aws_s3_bucket_policy.artifacts')).toBe(true);
    expect(has('data.aws_iam_policy_document.readonly', 'aws_s3_bucket_policy.artifacts')).toBe(true);
    expect(has('module.vpc', 'vpc_id')).toBe(true);
    // `type = string` is a type constructor, never a value reference.
    expect(ir.references.some((r) => r.name === 'string')).toBe(false);
  });

  it('treats a local module source as an import and resolves it to the module files', async () => {
    const ir = (await extractFile('infra/main.tf', src))!;
    const imp = ir.imports.find((i) => i.source === './modules/vpc')!;
    expect(imp.alias).toBe('vpc');
    expect(terraform.resolveModule('./modules/vpc', 'infra/main.tf', imp, { hasFile: () => false })).toContain(
      'infra/modules/vpc/main.tf',
    );
    expect(terraform.resolveModule('terraform-aws-modules/vpc/aws', 'infra/main.tf', imp, { hasFile: () => false })).toEqual([]);
  });

  it('handles plain HCL through the hcl grammar', async () => {
    const ir = (await extractFile('build/packer.hcl', packer))!;
    expect(ir.language).toBe('hcl');
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    expect(by['var.region'].kind).toBe('variable');
    expect(by['source.amazon-ebs.base'].kind).toBe('struct');
    expect(ir.references.some((r) => r.name === 'var.region')).toBe(true);
  });
});
