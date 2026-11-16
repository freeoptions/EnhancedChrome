export class BookmarkRenderQueue {
  constructor(nodeList, chunkSize = 40) {
    this.nodeList = nodeList;
    this.chunkSize = chunkSize;
    this.renderedCount = 0;
  }

  update(nodeList) {
    this.nodeList = nodeList;
    this.renderedCount = Math.min(this.renderedCount, nodeList.length);
    return nodeList.slice(0, this.renderedCount);
  }

  next(viewportEnd, rowHeight) {
    const targetCount = Math.min(this.nodeList.length,
      Math.max(1, Math.ceil(Math.max(0, viewportEnd) / rowHeight)) + this.chunkSize);
    if (this.renderedCount >= targetCount) return [];
    const nextCount = Math.min(this.nodeList.length, this.renderedCount + this.chunkSize);
    const chunkList = this.nodeList.slice(this.renderedCount, nextCount);
    this.renderedCount = nextCount;
    return chunkList;
  }
}
