/**
 * Top-level standard-library module names (CPython `sys.stdlib_module_names`, 3.14, plus modules removed in 3.12–3.13), as data.
 * Used only when a project manifest cannot be modeled: then a non-local, non-stdlib name
 * might be a remapped local package, so it is reported as unresolved instead of external.
 */
/** Removed from recent releases (3.12: PEP 632 and asyncore/imp; 3.13: PEP 594), still imported by older code. */
const REMOVED_STDLIB_MODULES = [
  'distutils', 'imp', 'asynchat', 'asyncore', 'smtpd', 'aifc', 'audioop', 'cgi', 'cgitb', 'chunk', 'crypt', 'imghdr',
  'mailcap', 'msilib', 'nis', 'nntplib', 'ossaudiodev', 'pipes', 'sndhdr', 'spwd', 'sunau', 'telnetlib', 'uu', 'xdrlib',
  'lib2to3', 'binhex', 'formatter', 'parser', 'symbol', 'macpath', 'dummy_threading', '_dummy_thread',
];

export const PYTHON_STDLIB_MODULES: ReadonlySet<string> = new Set([
  ...REMOVED_STDLIB_MODULES,
  '__future__', '_abc', '_aix_support', '_android_support', '_apple_support', '_ast', '_ast_unparse',
  '_asyncio', '_bisect', '_blake2', '_bz2', '_codecs', '_codecs_cn', '_codecs_hk', '_codecs_iso2022',
  '_codecs_jp', '_codecs_kr', '_codecs_tw', '_collections', '_collections_abc', '_colorize',
  '_compat_pickle', '_contextvars', '_csv', '_ctypes', '_curses', '_curses_panel', '_datetime', '_dbm',
  '_decimal', '_elementtree', '_frozen_importlib', '_frozen_importlib_external', '_functools', '_gdbm',
  '_hashlib', '_heapq', '_hmac', '_imp', '_interpchannels', '_interpqueues', '_interpreters', '_io',
  '_ios_support', '_json', '_locale', '_lsprof', '_lzma', '_markupbase', '_md5', '_multibytecodec',
  '_multiprocessing', '_opcode', '_opcode_metadata', '_operator', '_osx_support', '_overlapped', '_pickle',
  '_posixshmem', '_posixsubprocess', '_py_abc', '_py_warnings', '_pydatetime', '_pydecimal', '_pyio',
  '_pylong', '_pyrepl', '_queue', '_random', '_remote_debugging', '_scproxy', '_sha1', '_sha2', '_sha3',
  '_signal', '_sitebuiltins', '_socket', '_sqlite3', '_sre', '_ssl', '_stat', '_statistics', '_string',
  '_strptime', '_struct', '_suggestions', '_symtable', '_sysconfig', '_thread', '_threading_local',
  '_tkinter', '_tokenize', '_tracemalloc', '_types', '_typing', '_uuid', '_warnings', '_weakref',
  '_weakrefset', '_winapi', '_wmi', '_zoneinfo', '_zstd', 'abc', 'annotationlib', 'antigravity', 'argparse',
  'array', 'ast', 'asyncio', 'atexit', 'base64', 'bdb', 'binascii', 'bisect', 'builtins', 'bz2', 'cProfile',
  'calendar', 'cmath', 'cmd', 'code', 'codecs', 'codeop', 'collections', 'colorsys', 'compileall',
  'compression', 'concurrent', 'configparser', 'contextlib', 'contextvars', 'copy', 'copyreg', 'csv',
  'ctypes', 'curses', 'dataclasses', 'datetime', 'dbm', 'decimal', 'difflib', 'dis', 'doctest', 'email',
  'encodings', 'ensurepip', 'enum', 'errno', 'faulthandler', 'fcntl', 'filecmp', 'fileinput', 'fnmatch',
  'fractions', 'ftplib', 'functools', 'gc', 'genericpath', 'getopt', 'getpass', 'gettext', 'glob',
  'graphlib', 'grp', 'gzip', 'hashlib', 'heapq', 'hmac', 'html', 'http', 'idlelib', 'imaplib', 'importlib',
  'inspect', 'io', 'ipaddress', 'itertools', 'json', 'keyword', 'linecache', 'locale', 'logging', 'lzma',
  'mailbox', 'marshal', 'math', 'mimetypes', 'mmap', 'modulefinder', 'msvcrt', 'multiprocessing', 'netrc',
  'nt', 'ntpath', 'nturl2path', 'numbers', 'opcode', 'operator', 'optparse', 'os', 'pathlib', 'pdb',
  'pickle', 'pickletools', 'pkgutil', 'platform', 'plistlib', 'poplib', 'posix', 'posixpath', 'pprint',
  'profile', 'pstats', 'pty', 'pwd', 'py_compile', 'pyclbr', 'pydoc', 'pydoc_data', 'pyexpat', 'queue',
  'quopri', 'random', 're', 'readline', 'reprlib', 'resource', 'rlcompleter', 'runpy', 'sched', 'secrets',
  'select', 'selectors', 'shelve', 'shlex', 'shutil', 'signal', 'site', 'smtplib', 'socket', 'socketserver',
  'sqlite3', 'sre_compile', 'sre_constants', 'sre_parse', 'ssl', 'stat', 'statistics', 'string',
  'stringprep', 'struct', 'subprocess', 'symtable', 'sys', 'sysconfig', 'syslog', 'tabnanny', 'tarfile',
  'tempfile', 'termios', 'textwrap', 'this', 'threading', 'time', 'timeit', 'tkinter', 'token', 'tokenize',
  'tomllib', 'trace', 'traceback', 'tracemalloc', 'tty', 'turtle', 'turtledemo', 'types', 'typing',
  'unicodedata', 'unittest', 'urllib', 'uuid', 'venv', 'warnings', 'wave', 'weakref', 'webbrowser', 'winreg',
  'winsound', 'wsgiref', 'xml', 'xmlrpc', 'zipapp', 'zipfile', 'zipimport', 'zlib', 'zoneinfo',
]);
