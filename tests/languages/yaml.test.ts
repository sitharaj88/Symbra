import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFile } from '../../src/index/extract.js';
import { registerLanguage } from '../../src/languages/registry.js';
import { yaml } from '../../src/languages/yaml.js';

const read = (name: string) => readFileSync(new URL(`../fixtures/yaml/${name}`, import.meta.url), 'utf8');

beforeAll(() => {
  registerLanguage(yaml);
});

describe('yaml extractor', () => {
  it('indexes GitHub Actions jobs, steps and secrets', async () => {
    const ir = (await extractFile('.github/workflows/ci.yml', read('ci-workflow.yml')))!;
    expect(ir.language).toBe('yaml');
    expect(ir.doc).toBe('Continuous integration for the service.');
    const by = Object.fromEntries(ir.definitions.map((d) => [d.name, d]));
    expect(by['job:build'].kind).toBe('function');
    expect(by['job:build'].doc).toBe('Compile and unit-test.');
    expect(by['job:build'].meta).toMatchObject({ ci: 'github-actions', runsOn: 'ubuntu-latest' });
    expect(by['job:deploy'].meta).toMatchObject({ needs: 'build' });

    const buildOrd = by['job:build'].ordinal;
    const deployOrd = by['job:deploy'].ordinal;
    expect(ir.references).toContainEqual(expect.objectContaining({ kind: 'value', name: 'job:build', scope: deployOrd }));
    expect(ir.references).toContainEqual(expect.objectContaining({ kind: 'config', name: 'NPM_TOKEN', scope: buildOrd }));
    expect(ir.references).toContainEqual(expect.objectContaining({ kind: 'config', name: 'RELEASE_CHANNEL', scope: buildOrd }));
    expect(ir.references).toContainEqual(expect.objectContaining({ kind: 'config', name: 'NODE_ENV', scope: buildOrd }));
    // `${{ secrets.X }}` is counted once, not once per enclosing block.
    expect(ir.references.filter((r) => r.name === 'NPM_TOKEN')).toHaveLength(1);

    expect(ir.imports.map((i) => i.source)).toContain('actions/checkout@v4');
    expect(ir.imports.map((i) => i.source)).toContain('./.github/actions/setup');
    expect(yaml.resolveModule('./.github/actions/setup', '.github/workflows/ci.yml', ir.imports[0]!, { hasFile: () => false })).toContain(
      '.github/actions/setup/action.yml',
    );
    expect(yaml.resolveModule('actions/checkout@v4', '.github/workflows/ci.yml', ir.imports[0]!, { hasFile: () => false })).toEqual([]);
  });

  it('indexes GitLab CI jobs', async () => {
    const ir = (await extractFile('.gitlab-ci.yml', read('gitlab-ci.yml')))!;
    const by = Object.fromEntries(ir.definitions.map((d) => [d.name, d]));
    expect(Object.keys(by).sort()).toEqual(['job:build', 'job:deploy']);
    expect(by['job:build'].doc).toBe('Compile the project.');
    expect(by['job:build'].meta).toMatchObject({ ci: 'gitlab', stage: 'build', image: 'node:20' });
    expect(ir.references).toContainEqual(
      expect.objectContaining({ kind: 'value', name: 'job:build', scope: by['job:deploy'].ordinal }),
    );
    expect(ir.references).toContainEqual(
      expect.objectContaining({ kind: 'config', name: 'NPM_TOKEN', scope: by['job:build'].ordinal }),
    );
  });

  it('indexes docker-compose services with their dependencies and env keys', async () => {
    const ir = (await extractFile('docker-compose.yml', read('docker-compose.yml')))!;
    const by = Object.fromEntries(ir.definitions.map((d) => [d.name, d]));
    expect(Object.keys(by).sort()).toEqual(['api', 'cache', 'db']);
    expect(by['api'].kind).toBe('struct');
    expect(by['api'].doc).toBe('The public API.');
    expect(by['api'].meta).toMatchObject({ image: 'ghcr.io/acme/api:1.2.3' });
    const apiOrd = by['api'].ordinal;
    expect(ir.references).toContainEqual(expect.objectContaining({ kind: 'value', name: 'db', scope: apiOrd }));
    expect(ir.references).toContainEqual(expect.objectContaining({ kind: 'value', name: 'cache', scope: apiOrd }));
    expect(ir.references).toContainEqual(expect.objectContaining({ kind: 'config', name: 'DATABASE_URL', scope: apiOrd }));
    // list-form `- POSTGRES_PASSWORD=secret`
    expect(ir.references).toContainEqual(
      expect.objectContaining({ kind: 'config', name: 'POSTGRES_PASSWORD', scope: by['db'].ordinal }),
    );
    expect(ir.imports.map((i) => i.source)).toEqual(['./api.env']);
  });

  it('indexes each Kubernetes document as Kind/name', async () => {
    const ir = (await extractFile('k8s/deployment.yaml', read('deployment.yaml')))!;
    const names = ir.definitions.map((d) => d.name);
    expect(names).toEqual(['Deployment/api', 'Service/api']);
    const dep = ir.definitions[0]!;
    expect(dep.kind).toBe('struct');
    expect(dep.meta).toMatchObject({ k8sKind: 'Deployment', k8sName: 'api', namespace: 'prod' });
    expect(ir.references).toContainEqual(
      expect.objectContaining({ kind: 'value', name: 'ServiceAccount/api-runner', scope: dep.ordinal }),
    );
    expect(ir.references).toContainEqual(
      expect.objectContaining({ kind: 'value', name: 'Secret/api-secrets', scope: dep.ordinal }),
    );
    expect(ir.references).toContainEqual(expect.objectContaining({ kind: 'config', name: 'DATABASE_URL', scope: dep.ordinal }));
    expect(ir.references).toContainEqual(expect.objectContaining({ kind: 'config', name: 'LOG_LEVEL', scope: dep.ordinal }));
  });

  it('indexes OpenAPI routes and schemas', async () => {
    const ir = (await extractFile('api/openapi.yaml', read('openapi.yaml')))!;
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    expect(by['GET /pets'].kind).toBe('route');
    expect(by['GET /pets'].doc).toBe('List all pets.');
    expect(by['GET /pets'].meta).toMatchObject({ httpMethod: 'GET', path: '/pets', operationId: 'listPets' });
    expect(by['POST /pets'].meta).toMatchObject({ operationId: 'createPet' });
    expect(by['GET /pets/{id}'].kind).toBe('route');
    expect(by['Pet'].kind).toBe('struct');
    expect(by['Pet'].doc).toBe('A pet.');
    expect(by['Pet.id'].kind).toBe('field');
    expect(by['Pet.id'].declaredType).toBe('integer');
    expect(by['Pet.owner'].declaredType).toBe('Owner');
    expect(ir.references).toContainEqual(
      expect.objectContaining({ kind: 'type', name: 'Pet', scope: by['GET /pets'].ordinal }),
    );
    expect(ir.references).toContainEqual(expect.objectContaining({ kind: 'type', name: 'Owner' }));
  });

  it('indexes nothing for YAML of an unknown shape', async () => {
    const ir = (await extractFile('config/plain.yml', read('plain.yml')))!;
    expect(ir.definitions).toEqual([]);
    expect(ir.references).toEqual([]);
    expect(ir.imports).toEqual([]);
  });
});
