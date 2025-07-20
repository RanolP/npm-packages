# p-abort

Abortable step-by-step operations with automatic cleanup.

## Installation

```bash
npm install p-abort
```

```bash
pnpm add p-abort
```

```bash
yarn add p-abort
```

## Overview

`p-abort` provides a utility for creating abortable asynchronous operations that can be cleanly cancelled at any step. It's particularly useful for:

- Long-running async operations that need cancellation support
- Multi-step workflows where intermediate steps should be skippable
- Resource cleanup when operations are aborted
- Preventing race conditions in async code

## Usage

### Basic Example

```typescript
import { abortable } from 'p-abort';

const operation = abortable($ => async (id: string) => {
  // Step 1: Fetch user data
  const user = await $(fetchUser(id));
  
  // Step 2: Fetch user's posts
  const posts = await $(fetchPosts(user.id));
  
  // Step 3: Process posts
  const processed = await $(processPosts(posts));
  
  return processed;
});

// Start the operation
const promise = operation('user123');

// Later, abort if needed
setTimeout(() => {
  promise.abort();
}, 1000);

// Handle result
const result = await promise;
if (result.ok) {
  console.log('Success:', result.data);
} else {
  console.log('Operation was aborted');
}
```

### With Cleanup

```typescript
import { abortable } from 'p-abort';

const uploadWithProgress = abortable($ => async (file: File) => {
  const controller = new AbortController();
  
  // Register cleanup function
  $.cleanup(() => {
    controller.abort();
    console.log('Upload cancelled, cleaning up...');
  });
  
  // Start upload
  const response = await $(uploadFile(file, { signal: controller.signal }));
  
  // Process response
  return response;
});

const upload = uploadWithProgress(myFile);

// Cancel upload
upload.abort();
```

### Function Wrapping

The `$` utility can also wrap functions to make them abort-aware:

```typescript
import { abortable } from 'p-abort';

const processData = abortable($ => async (items: string[]) => {
  // Wrap an existing function to be abort-aware
  const abortableFetch = $(fetchData);
  
  const results = [];
  for (const item of items) {
    const data = await abortableFetch(item);
    results.push(data);
  }
  
  return results;
});
```

## API

### `abortable(fn)`

Creates an abortable operation from a function that receives an abort-aware utility.

#### Parameters

- `fn`: A function that receives the `$` utility and returns an async function

#### Returns

A function that returns a `Promise` with an additional `abort()` method.

#### Promise Result

The returned promise resolves to:
- `{ ok: true, data: T }` on successful completion
- `{ ok: false }` if the operation was aborted

### `$` Utility

The `$` utility provides several methods for making operations abort-aware:

#### `$(promise)`
Wraps a promise or value to be abort-aware. If the operation is aborted before completion, it throws an `AbortedError`.

#### `$(fn)`
Wraps a function to make it abort-aware. The wrapped function will check for abortion before and after execution.

#### `$.cleanup(fn)`
Registers a cleanup function to be called when the operation completes or is aborted. Cleanup functions are executed in reverse order of registration (LIFO). Useful for resource cleanup.

## Error Handling

When an operation is aborted, any in-progress steps are cancelled and the promise resolves to `{ ok: false }`. Other errors are propagated normally.

```typescript
const operation = abortable($ => async () => {
  try {
    const result = await $(someAsyncOperation());
    return result;
  } catch (error) {
    if (error instanceof AbortedError) {
      console.log('Operation was cancelled');
    }
    throw error;
  }
});
```

## Advanced Usage

### Chaining Operations

```typescript
const complexWorkflow = abortable($ => async (input: string) => {
  // Step 1: Validate
  const validated = await $(validateInput(input));
  
  // Step 2: Transform
  const transformed = await $(transformData(validated));
  
  // Step 3: Save with retry
  const saved = await $(retry(() => saveData(transformed), 3));
  
  // Step 4: Notify
  await $(sendNotification(saved));
  
  return saved;
});
```

### Resource Management

```typescript
const fileProcessor = abortable($ => async (filePath: string) => {
  const file = await $(openFile(filePath));
  
  // Ensure file is closed on abort
  $.cleanup(() => {
    file.close();
    console.log('File closed due to abort');
  });
  
  const content = await $(readFile(file));
  const processed = await $(processContent(content));
  
  return processed;
});
```

## TypeScript Support

This package is written in TypeScript and provides full type safety:

```typescript
interface UserData {
  id: string;
  name: string;
}

const getUser = abortable($ => async (id: string): Promise<UserData> => {
  const response = await $(fetch(`/api/users/${id}`));
  return response.json();
});

// Type is inferred as:
// const getUser: (id: string) => Promise<
//   { ok: true; data: UserData } | { ok: false }
// > & { abort: () => void }
```

## License

MIT © [RanolP](https://github.com/RanolP)
