import type { SQL } from 'bun'

type Column<Entity> = Extract<keyof Entity, string>
type SqlValue = string | number | Date | null

// Mappings define identifiers; data values are always bound as parameters.
export interface EntityMapping<Entity> {
  table: string
  columns: readonly Column<Entity>[]
}

export type OrmCondition<Entity> = {
  [Key in Column<Entity>]:
    | { column: Key; operator: '=' | '>'; value: Entity[Key] }
    | { column: Key; operator: 'IS NULL' }
}[Column<Entity>]

interface Statement {
  text: string
  parameters: SqlValue[]
}

interface SelectOptions<Entity> {
  where?: readonly OrmCondition<Entity>[]
  orderBy?: readonly Column<Entity>[]
  forUpdate?: boolean
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) {
    throw new Error(`Invalid ORM identifier: ${value}`)
  }
  return `"${value}"`
}

function mappedColumn<Entity>(
  mapping: EntityMapping<Entity>,
  column: Column<Entity>,
): string {
  if (!mapping.columns.includes(column)) {
    throw new Error(`Unmapped column ${column} on ${mapping.table}`)
  }
  return identifier(column)
}

function sqlValue(value: unknown): SqlValue {
  if (value === null) {
    return null
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return value
  }
  if (value instanceof Date) {
    return value
  }
  throw new Error('ORM values must be strings, numbers, dates or null')
}

function whereClause<Entity>(
  mapping: EntityMapping<Entity>,
  conditions: readonly OrmCondition<Entity>[],
  parameters: SqlValue[],
): string {
  if (conditions.length === 0) {
    return ''
  }
  const clauses = conditions.map((condition) => {
    const column = mappedColumn(mapping, condition.column)
    if (condition.operator === 'IS NULL') {
      return `${column} IS NULL`
    }
    if (condition.operator !== '=' && condition.operator !== '>') {
      throw new Error(`Unsupported ORM operator: ${condition.operator}`)
    }
    parameters.push(sqlValue(condition.value))
    return `${column} ${condition.operator} $${parameters.length}`
  })
  return ` WHERE ${clauses.join(' AND ')}`
}

export function selectStatement<Entity>(
  mapping: EntityMapping<Entity>,
  options: SelectOptions<Entity> = {},
): Statement {
  const parameters: SqlValue[] = []
  const columns = mapping.columns
    .map((column) => mappedColumn(mapping, column))
    .join(', ')
  const where = whereClause(mapping, options.where ?? [], parameters)
  const orderBy = options.orderBy?.length
    ? ` ORDER BY ${options.orderBy.map((column) => mappedColumn(mapping, column)).join(', ')}`
    : ''
  const lock = options.forUpdate ? ' FOR UPDATE' : ''
  return {
    text: `SELECT ${columns} FROM ${identifier(mapping.table)}${where}${orderBy}${lock}`,
    parameters,
  }
}

export function insertStatement<Entity>(
  mapping: EntityMapping<Entity>,
  values: Partial<Entity>,
): Statement {
  const columns = mapping.columns.filter((column) =>
    Object.prototype.hasOwnProperty.call(values, column),
  )
  if (columns.length === 0) {
    throw new Error(`No values supplied for ${mapping.table}`)
  }
  const parameters = columns.map((column) => {
    const value = values[column]
    if (value === undefined) {
      throw new Error(`Missing value for ${mapping.table}.${column}`)
    }
    return sqlValue(value)
  })
  return {
    text: `INSERT INTO ${identifier(mapping.table)} (${columns
      .map((column) => mappedColumn(mapping, column))
      .join(
        ', ',
      )}) VALUES (${parameters.map((_, index) => `$${index + 1}`).join(', ')})`,
    parameters,
  }
}

export function updateStatement<Entity>(
  mapping: EntityMapping<Entity>,
  values: Partial<Entity>,
  where: readonly OrmCondition<Entity>[],
): Statement {
  if (where.length === 0) {
    throw new Error('ORM updates require at least one condition')
  }
  const columns = mapping.columns.filter((column) =>
    Object.prototype.hasOwnProperty.call(values, column),
  )
  if (columns.length === 0) {
    throw new Error(`No values supplied for ${mapping.table}`)
  }
  const parameters = columns.map((column) => {
    const value = values[column]
    if (value === undefined) {
      throw new Error(`Missing value for ${mapping.table}.${column}`)
    }
    return sqlValue(value)
  })
  const assignments = columns.map(
    (column, index) => `${mappedColumn(mapping, column)} = $${index + 1}`,
  )
  const filter = whereClause(mapping, where, parameters)
  return {
    text: `UPDATE ${identifier(mapping.table)} SET ${assignments.join(', ')}${filter}`,
    parameters,
  }
}

export function sumStatement<Entity>(
  mapping: EntityMapping<Entity>,
  column: Column<Entity>,
  where: readonly OrmCondition<Entity>[],
): Statement {
  const parameters: SqlValue[] = []
  const filter = whereClause(mapping, where, parameters)
  return {
    text: `SELECT COALESCE(SUM(${mappedColumn(mapping, column)}), 0)::int AS "total" FROM ${identifier(mapping.table)}${filter}`,
    parameters,
  }
}

export class Orm {
  constructor(private readonly sql: SQL) {}

  select<Entity>(
    mapping: EntityMapping<Entity>,
    options: SelectOptions<Entity> = {},
  ): Promise<Entity[]> {
    const statement = selectStatement(mapping, options)
    return this.sql.unsafe<Entity[]>(statement.text, statement.parameters)
  }

  async insert<Entity>(
    mapping: EntityMapping<Entity>,
    values: Partial<Entity>,
  ): Promise<void> {
    const statement = insertStatement(mapping, values)
    await this.sql.unsafe(statement.text, statement.parameters)
  }

  async update<Entity>(
    mapping: EntityMapping<Entity>,
    values: Partial<Entity>,
    where: readonly OrmCondition<Entity>[],
  ): Promise<void> {
    const statement = updateStatement(mapping, values, where)
    await this.sql.unsafe(statement.text, statement.parameters)
  }

  async sum<Entity>(
    mapping: EntityMapping<Entity>,
    column: Column<Entity>,
    where: readonly OrmCondition<Entity>[],
  ): Promise<number> {
    const statement = sumStatement(mapping, column, where)
    const [row] = await this.sql.unsafe<{ total: number }[]>(
      statement.text,
      statement.parameters,
    )
    if (!row) {
      throw new Error(`Unable to calculate ${mapping.table}.${column}`)
    }
    return row.total
  }
}
