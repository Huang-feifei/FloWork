/** 数据库工作台协议：不向 Renderer 返回数据库密码。 */
export type DatabaseKind = "sqlite" | "postgres" | "mysql";
export interface DatabaseInput {
	name: string;
	kind: DatabaseKind;
	file?: string;
	host?: string;
	port?: number;
	database?: string;
	user?: string;
	/** 更新时省略保留原密码，空字符串清除。 */
	password?: string;
	sshHostId?: string;
	readOnly: boolean;
	/** TLS 校验证书，不提供跳过校验选项。 */
	tls?: boolean;
}
export interface DatabaseConnection extends Omit<DatabaseInput, "password"> {
	id: string;
	hasPassword: boolean;
	createdAt: number;
}
export interface DatabaseTable { schema: string; name: string; type: "table" | "view" }
export interface DatabaseColumn { name: string; type: string; nullable: boolean; primaryKey: boolean }
export type DatabaseCell = string | number | boolean | null;
export interface DatabaseResult {
	columns: string[];
	rows: DatabaseCell[][];
	affectedRows: number;
	durationMs: number;
	truncated: boolean;
	readOnly: boolean;
}
export interface DatabasePage extends DatabaseResult {
	tableColumns: DatabaseColumn[];
	page: number;
	pageSize: number;
	hasMore: boolean;
}
export interface DatabaseHistory { id: string; connectionId: string; sql: string; createdAt: number; durationMs: number; ok: boolean; error?: string }
export interface DatabaseSavedQuery { id: string; connectionId: string; name: string; sql: string; createdAt: number }
export interface DatabaseQueryParams { connectionId: string; sql: string; confirmationToken?: string }
export interface DatabaseBrowseParams {
	connectionId: string;
	table: DatabaseTable;
	page?: number;
	pageSize?: number;
	/** 单条 SQL 表达式；在真正的只读连接/事务内执行。 */
	filter?: string;
	orderBy?: string;
	descending?: boolean;
}
export interface DatabaseMethods {
	"database.list": { params: undefined; result: DatabaseConnection[] };
	"database.save": { params: { id?: string; input: DatabaseInput }; result: DatabaseConnection };
	"database.remove": { params: { id: string }; result: null };
	"database.test": { params: { id?: string; input: DatabaseInput }; result: { durationMs: number } };
	"database.pickFile": { params: undefined; result: string | null };
	"database.tables": { params: { connectionId: string }; result: DatabaseTable[] };
	"database.browse": { params: DatabaseBrowseParams; result: DatabasePage };
	"database.query": { params: DatabaseQueryParams; result: DatabaseResult };
	"database.prepareWrite": { params: { connectionId: string; sql: string }; result: { token: string } };
	"database.cancel": { params: undefined; result: null };
	"database.history": { params: { connectionId: string }; result: DatabaseHistory[] };
	"database.clearHistory": { params: { connectionId: string }; result: null };
	"database.saved": { params: { connectionId: string }; result: DatabaseSavedQuery[] };
	"database.saveQuery": { params: { connectionId: string; name: string; sql: string }; result: DatabaseSavedQuery };
	"database.removeQuery": { params: { id: string }; result: null };
}
