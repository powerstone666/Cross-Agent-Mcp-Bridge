// A small async queue: callbacks `push` items in, a `for await` loop reads them out.
// Never drop an item that was pushed before `end`.

export interface AsyncQueue<Item> extends AsyncIterable<Item> {
  push(item: Item): void;
  end(): void;
}

// `push` never blocks or throws. `end` is final, and later pushes are ignored.
// One reader at a time.
export function createAsyncQueue<Item>(): AsyncQueue<Item> {
  // Items pushed while no reader was waiting, so none are lost between `next()` calls.
  const bufferedItems: Item[] = [];
  const waitingConsumers: Array<(result: IteratorResult<Item>) => void> = [];
  let isEnded = false;

  return {
    push(item) {
      if (isEnded) return;
      const consumer = waitingConsumers.shift();
      if (consumer) consumer({ value: item, done: false });
      else bufferedItems.push(item);
    },
    end() {
      isEnded = true;
      for (const consumer of waitingConsumers.splice(0)) {
        consumer({ value: undefined, done: true });
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<Item>> {
          // Buffer first, even after `end`, so no queued item is dropped.
          // Limit: an `undefined` item would be mistaken for an empty buffer.
          const bufferedItem = bufferedItems.shift();
          if (bufferedItem !== undefined) {
            return Promise.resolve({ value: bufferedItem, done: false });
          }
          if (isEnded) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => waitingConsumers.push(resolve));
        },
      };
    },
  };
}
