// Small collection helpers shared across commands.

export function chunkArray(items, size) {
    if (!Number.isInteger(size) || size <= 0) {
        throw new Error('chunkArray size must be a positive integer');
    }
    const chunks = [];
    for (let i = 0; i < items.length; i += size) {
        chunks.push(items.slice(i, i + size));
    }
    return chunks;
}
