/**
 * Stack data structure.
 * push and pop work, but peek, isEmpty, size, and toArray are missing.
 */
export class Stack<T> {
  private items: T[] = [];

  push(item: T): void {
    this.items.push(item);
  }

  pop(): T | undefined {
    return this.items.pop();
  }

  // TODO: implement peek — returns top item without removing
  // TODO: implement isEmpty — returns true if stack is empty
  // TODO: implement size — returns number of items
  // TODO: implement toArray — returns copy of items as array
}
