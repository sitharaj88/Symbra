/** Service layer. */
import { Repo } from './repo';
import * as utils from '../utils';
import type { Config } from './config';
const legacy = require('./legacy');

export interface Greeter {
  greet(name: string): string;
}

export abstract class Base<T> implements Greeter {
  protected repo: Repo;
  constructor(private readonly config: Config) {
    this.repo = new Repo(config);
  }
  abstract greet(name: string): string;
}

/** Concrete service. */
export class UserService extends Base<string> {
  static instances = 0;
  greet(name: string): string {
    const r = this.repo.find(name);
    utils.log(r);
    return legacy.format(name);
  }
  async load(): Promise<void> {
    await this.repo.load();
  }
}

export const helper = (x: number) => x * 2;
export function main() {
  const svc = new UserService({} as Config);
  svc.greet('x');
  return helper(1) + Number(process.env.PORT);
}

app.get('/users/:id', main);

describe('UserService', () => {
  it('greets', () => {
    expect(new UserService({} as Config).greet('a')).toBe('a');
  });
});
