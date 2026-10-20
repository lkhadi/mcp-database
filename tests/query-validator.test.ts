import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QueryValidator } from '../src/utils/query-validator.js';
import type { DatabaseType } from '../src/db/types.js';

const validator = new QueryValidator(['DROP', 'TRUNCATE', 'ALTER', 'GRANT', 'REVOKE'], true);

const blocked: Array<[DatabaseType, string]> = [
    ['postgresql', "SELECT '--'; DROP TABLE example"],
    ['mysql', "SELECT '/*'; DROP TABLE example; SELECT '*/'"],
    ['postgresql', "SELECT 'it''s -- text'; ALTER TABLE example ADD x int"],
    ['postgresql', 'SELECT 1;/**/DROP/**/TABLE example'],
    ['mysql', '/*!50000 DROP TABLE example */'],
    ['mysql', '/*M! DROP TABLE example */'],
    ['mysql', 'SELECT 1--2; DROP TABLE example'],
    ['mysql', 'SELECT 1--\u00a0; DROP TABLE example'],
    ['postgresql', 'SELECT 1 AS ‽$tag$; DROP TABLE example; SELECT 1 AS ‽$tag$'],
    ['postgresql', "SELECT 'unterminated"],
    ['mysql', 'SELECT 1 /* unterminated'],
    ['mysql', String.raw`SELECT '\'; DROP TABLE example; -- '`],
];
for (const [dialect, sql] of blocked) {
    test(`blocks unsafe or ambiguous ${dialect} SQL: ${sql}`, () => {
        assert.equal(validator.validate(sql, dialect).valid, false);
    });
}

const allowed: Array<[DatabaseType, string]> = [
    ['postgresql', "SELECT 'DROP', 'it''s fine', '--', '/*'"],
    ['mysql', 'SELECT `DROP`, "ALTER", 1 # DROP TABLE example'],
    ['mysql', 'SELECT 1 -- DROP TABLE example'],
    ['postgresql', 'SELECT $$DROP; -- $$, $tag$ALTER /*$tag$'],
    ['postgresql', 'SELECT $‽$DROP; --$‽$'],
    ['postgresql', '/* outer /* inner */ DROP ignored */ SELECT 1'],
    ['postgresql', String.raw`SELECT E'it\'s DROP'`],
    ['postgresql', '-- comment with an unmatched quote: \'\nSELECT 1'],
    ['postgresql', 'SELECT 1 AS dropped_count /* DROP TABLE example */'],
];
for (const [dialect, sql] of allowed) {
    test(`allows ordinary ${dialect} SQL: ${sql}`, () => {
        assert.equal(validator.validate(sql, dialect).valid, true);
    });
}

test('still supports disabled protection and configured literal patterns', () => {
    assert.equal(new QueryValidator(['DROP'], false).validate('DROP TABLE example').valid, true);
    assert.equal(new QueryValidator(['DELETE'], true).validate('DELETE FROM example').valid, false);
    assert.equal(validator.validate('SELECT drop_count FROM example').valid, true);
});
