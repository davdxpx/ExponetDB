-- PostgreSQL 16/17/18 run this and return 'ab'. libpg_query 16.7.3 / 17.7.4 / 18.1.5 (the repo's parser) refuse it
-- ("syntax error at or near 'b'"), so lint reports parse_error. c1 N4 treats it as ONE literal token.
SELECT 'a'
-- a comment between the pieces
'b' AS v;
