/** Formats greetings. */
export class Greeter {
  constructor(private readonly prefix: string) {}

  /** Build a greeting for a name. */
  greet(name: string): string {
    return `${this.prefix}, ${name}!`;
  }
}

export interface Named {
  name: string;
}

export class Person implements Named {
  constructor(public name: string) {}
}

/** Capitalise the first letter. */
export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
