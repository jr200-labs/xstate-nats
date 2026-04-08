import { describe, it, expect } from 'vitest'
import { Pair } from './utils'

describe('Pair', () => {
  it('should create a pair and convert to key', () => {
    const pair = new Pair('test', 123)
    const key = pair.toKey()

    expect(key).toBe('Pair(test, 123)')
    expect(pair.x).toBe('test')
    expect(pair.y).toBe(123)
  })

  it('should parse pair from key', () => {
    const key = 'Pair(hello, 456)'
    const pair = Pair.fromKey(key)

    expect(pair.x).toBe('hello')
    expect(pair.y).toBe('456')
  })

  it('should throw on invalid key format', () => {
    expect(() => Pair.fromKey('invalid')).toThrow('Invalid Pair key format: invalid')
    expect(() => Pair.fromKey('Pair(only_one)')).toThrow('Invalid Pair key format')
  })

  it('should check equality correctly', () => {
    const pair1 = new Pair('a', 'b')
    const pair2 = new Pair('a', 'b')
    const pair3 = new Pair('a', 'c')

    expect(pair1.equals(pair2)).toBe(true)
    expect(pair1.equals(pair3)).toBe(false)
  })
})
