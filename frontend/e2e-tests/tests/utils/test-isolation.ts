/**
 * 测试工具函数
 * 提供测试数据隔离和清理
 */

/**
 * 生成唯一的测试名称（避免上下文污染）
 */
export function uniqueTestName(prefix: string = 'test'): string {
  const timestamp = Date.now()
  const random = Math.random().toString(36).slice(2, 8)
  return `${prefix}-${timestamp}-${random}`
}

/**
 * 创建测试隔离器
 * 每个测试文件用唯一的命名空间，避免冲突
 */
export class TestIsolation {
  private namespace: string
  private createdResources: Array<{ type: string; id: string; cleanup: () => Promise<void> }> = []

  constructor(namespace?: string) {
    this.namespace = namespace || uniqueTestName('test')
  }

  /**
   * 获取命名空间（用于创建测试数据）
   */
  getNamespace(): string {
    return this.namespace
  }

  /**
   * 注册资源（测试结束后自动清理）
   */
  registerResource(type: string, id: string, cleanup: () => Promise<void>): void {
    this.createdResources.push({ type, id, cleanup })
  }

  /**
   * 清理所有注册的资源
   */
  async cleanup(): Promise<{ cleaned: number; errors: number }> {
    let cleaned = 0
    let errors = 0

    // 逆序清理（后创建的先清理）
    for (const resource of this.createdResources.reverse()) {
      try {
        await resource.cleanup()
        cleaned++
      } catch (error) {
        console.error(`清理 ${resource.type}:${resource.id} 失败:`, error)
        errors++
      }
    }

    this.createdResources = []
    return { cleaned, errors }
  }
}

/**
 * 创建带隔离的测试 fixture
 */
export function createTestIsolation(): TestIsolation {
  return new TestIsolation()
}
