import { Greeter, Person, capitalize } from './greeter.js';

/** Entry point: greets a person. */
export function run(): string {
  const g = new Greeter('Hello');
  const p = new Person('ada');
  return g.greet(capitalize(p.name));
}

export class LoudGreeter extends Greeter {
  override greet(name: string): string {
    return super.greet(name).toUpperCase();
  }
}
